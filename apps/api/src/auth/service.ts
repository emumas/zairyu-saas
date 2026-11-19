/**
 * 認証(1-2): メール+パスワード、TOTP、リフレッシュトークンのローテーション。
 *
 * - エラーメッセージからユーザーの有無・ロック中か等が分からないよう、失敗は一律 UNAUTHORIZED
 * - テナント管理者・拠点管理者は TOTP 必須。未設定なら初回ログインで設定させる
 * - ログイン失敗と TOTP の失敗は合算して数え、上限でアカウントを一定時間ロックする
 * - ログ・監査ログにパスワード・トークン・TOTP コードを残さない
 */
import { lookupUserForLogin, schema, withTenant, type Db, type Tx } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Role } from "../authz/permissions.js";
import { verifyPassword } from "./password.js";
import type { SecretBox } from "./secretBox.js";
import { generateTotpSecret, otpauthUri, base32Encode, verifyTotp } from "./totp.js";
import { newRefreshToken, parseRefreshToken, signToken, verifyToken } from "./tokens.js";

const { users, tenants, refreshTokens, auditLogs } = schema;

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
}

export type LoginResult =
  | ({ status: "ok" } & TokenPair)
  | { status: "totp_required"; challengeToken: string }
  | { status: "totp_setup_required"; setupToken: string };

export interface RequestMeta {
  ip: string | null;
  deviceName?: string | undefined;
}

const fail = () => new TRPCError({ code: "UNAUTHORIZED", message: "メールアドレス・パスワードまたは確認コードが正しくありません" });
const expired = () => new TRPCError({ code: "UNAUTHORIZED", message: "セッションの有効期限が切れました。もう一度ログインしてください" });

/** TOTP を必須にするロール(DESIGN.md 5章) */
export function totpRequired(role: Role): boolean {
  return role === "tenant_admin" || role === "site_admin";
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now,
  ) {}

  private nowSec() {
    return Math.floor(this.now() / 1000);
  }

  async login(emailInput: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    const found = await lookupUserForLogin(this.db, email);
    if (!found) {
      await verifyPassword(null, password); // 応答時間をそろえる
      throw fail();
    }
    const result = await withTenant(this.db, found.tenant_id, async (tx) => {
      const user = await this.loadUser(tx, found.id);
      if (!user) return { ok: false as const };
      if (this.isLocked(user)) {
        await verifyPassword(null, password);
        await this.audit(tx, user.id, "auth.login_locked", meta);
        return { ok: false as const };
      }
      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid || user.status !== "active" || user.tenantStatus === "suspended") {
        if (!valid) await this.recordFailure(tx, user.id, user.failedLoginCount);
        await this.audit(tx, user.id, "auth.login_failed", meta);
        return { ok: false as const };
      }
      await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
      return { ok: true as const, user };
    });
    if (!result.ok) throw fail();

    const { user } = result;
    const claims = { userId: user.id, tenantId: found.tenant_id };
    if (user.totpEnabled) {
      const challengeToken = await signToken(this.config.jwtSecret, { ...claims, type: "totp_challenge" }, this.config.purposeTokenTtlSec, this.nowSec());
      return { status: "totp_required", challengeToken };
    }
    if (totpRequired(user.role)) {
      const setupToken = await signToken(this.config.jwtSecret, { ...claims, type: "totp_setup" }, this.config.purposeTokenTtlSec, this.nowSec());
      return { status: "totp_setup_required", setupToken };
    }
    const tokens = await withTenant(this.db, found.tenant_id, (tx) => this.completeLogin(tx, user.id, found.tenant_id, meta));
    return { status: "ok", ...tokens };
  }

  /** ログイン2段目: 認証アプリのコード */
  async verifyTotp(challengeToken: string, code: string, meta: RequestMeta): Promise<TokenPair> {
    const claims = await verifyToken(this.config.jwtSecret, challengeToken, "totp_challenge", this.nowSec());
    if (!claims) throw expired();
    const tokens = await withTenant(this.db, claims.tenantId, async (tx) => {
      const user = await this.loadUser(tx, claims.userId);
      if (!user || !user.totpEnabled || !user.totpSecretEnc || user.status !== "active" || this.isLocked(user)) return null;
      const secret = this.box.open(user.totpSecretEnc, totpAad(user.id));
      const step = verifyTotp(secret, code, this.now(), user.totpLastStep);
      if (step === null) {
        await this.recordFailure(tx, user.id, user.failedLoginCount);
        await this.audit(tx, user.id, "auth.totp_failed", meta);
        return null;
      }
      await tx.update(users).set({ totpLastStep: step, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
      return this.completeLogin(tx, user.id, claims.tenantId, meta);
    });
    if (!tokens) throw fail();
    return tokens;
  }

  /** TOTP 初期設定: 秘密鍵を作って返す(まだ有効化しない) */
  async beginTotpSetup(setupToken: string): Promise<{ secret: string; otpauthUri: string }> {
    const claims = await verifyToken(this.config.jwtSecret, setupToken, "totp_setup", this.nowSec());
    if (!claims) throw expired();
    return withTenant(this.db, claims.tenantId, async (tx) => {
      const user = await this.loadUser(tx, claims.userId);
      if (!user || user.totpEnabled || user.status !== "active") throw expired();
      const secret = generateTotpSecret();
      await tx
        .update(users)
        .set({ totpSecretEnc: this.box.seal(secret, totpAad(user.id)), totpLastStep: null })
        .where(eq(users.id, user.id));
      return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, user.email, this.config.totpIssuer) };
    });
  }

  /** TOTP 初期設定の確認: 認証アプリのコードが合えば有効化してログインを完了する */
  async confirmTotpSetup(setupToken: string, code: string, meta: RequestMeta): Promise<TokenPair> {
    const claims = await verifyToken(this.config.jwtSecret, setupToken, "totp_setup", this.nowSec());
    if (!claims) throw expired();
    const tokens = await withTenant(this.db, claims.tenantId, async (tx) => {
      const user = await this.loadUser(tx, claims.userId);
      if (!user || user.totpEnabled || !user.totpSecretEnc || user.status !== "active" || this.isLocked(user)) return null;
      const step = verifyTotp(this.box.open(user.totpSecretEnc, totpAad(user.id)), code, this.now(), null);
      if (step === null) {
        await this.recordFailure(tx, user.id, user.failedLoginCount);
        return null;
      }
      await tx
        .update(users)
        .set({ totpEnabled: true, totpLastStep: step, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      await this.audit(tx, user.id, "auth.totp_enabled", meta);
      return this.completeLogin(tx, user.id, claims.tenantId, meta);
    });
    if (!tokens) throw fail();
    return tokens;
  }

  /**
   * リフレッシュトークンを使って新しいトークンを発行する(ローテーション)。
   * 使用済みのトークンが再び使われたら、盗用とみなして同じ family をすべて失効させる
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw expired();
    const outcome = await withTenant(this.db, parsed.tenantId, async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, parsed.hash));
      if (!row || row.revokedAt || row.expiresAt.getTime() <= this.now()) return { kind: "invalid" as const };
      // 使用済みにする(同時に 2 回使われても片方だけが成功する)
      const claimed = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date(this.now()) })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });
      if (claimed.length === 0) {
        await tx.update(refreshTokens).set({ revokedAt: new Date(this.now()) }).where(eq(refreshTokens.familyId, row.familyId));
        await this.audit(tx, row.userId, "auth.refresh_reuse_detected", meta);
        return { kind: "reuse" as const };
      }
      const user = await this.loadUser(tx, row.userId);
      if (!user || user.status !== "active" || user.tenantStatus === "suspended") return { kind: "invalid" as const };
      return { kind: "ok" as const, tokens: await this.issueTokens(tx, row.userId, parsed.tenantId, row.familyId, meta) };
    });
    if (outcome.kind !== "ok") throw expired();
    return outcome.tokens;
  }

  /** ログアウト: そのリフレッシュトークンの family を失効させる */
  async logout(refreshToken: string, meta: RequestMeta): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    await withTenant(this.db, parsed.tenantId, async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, parsed.hash));
      if (!row) return;
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(this.now()) })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      await this.audit(tx, row.userId, "auth.logout", meta);
    });
  }

  // ---------------------------------------------------------------- 内部

  private async loadUser(tx: Tx, userId: string) {
    const [row] = await tx
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        role: users.role,
        status: users.status,
        totpEnabled: users.totpEnabled,
        totpSecretEnc: users.totpSecretEnc,
        totpLastStep: users.totpLastStep,
        failedLoginCount: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
        tenantStatus: tenants.status,
      })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(users.id, userId));
    return row ?? null;
  }

  private isLocked(user: { lockedUntil: Date | null }): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > this.now();
  }

  private async recordFailure(tx: Tx, userId: string, current: number): Promise<void> {
    const count = current + 1;
    const lock = count >= this.config.maxFailedLogins;
    await tx
      .update(users)
      .set({
        failedLoginCount: lock ? 0 : count,
        lockedUntil: lock ? new Date(this.now() + this.config.lockoutSec * 1000) : null,
      })
      .where(eq(users.id, userId));
  }

  private async completeLogin(tx: Tx, userId: string, tenantId: string, meta: RequestMeta): Promise<TokenPair> {
    await tx.update(users).set({ lastLoginAt: new Date(this.now()) }).where(eq(users.id, userId));
    await this.audit(tx, userId, "auth.login", meta);
    return this.issueTokens(tx, userId, tenantId, randomUUID(), meta);
  }

  private async issueTokens(tx: Tx, userId: string, tenantId: string, familyId: string, meta: RequestMeta): Promise<TokenPair> {
    const refreshToken = newRefreshToken(tenantId);
    await tx.insert(refreshTokens).values({
      userId,
      tokenHash: parseRefreshToken(refreshToken)!.hash,
      familyId,
      expiresAt: new Date(this.now() + this.config.refreshTokenTtlSec * 1000),
      deviceName: meta.deviceName?.slice(0, 100) ?? null,
    });
    const accessToken = await signToken(
      this.config.jwtSecret,
      { userId, tenantId, type: "access" },
      this.config.accessTokenTtlSec,
      this.nowSec(),
    );
    return { accessToken, accessTokenExpiresIn: this.config.accessTokenTtlSec, refreshToken };
  }

  private async audit(tx: Tx, actorId: string, action: string, meta: RequestMeta): Promise<void> {
    await tx.insert(auditLogs).values({ actorId, action, targetType: "user", targetId: actorId, ip: meta.ip });
  }
}

/** TOTP 秘密鍵の暗号文をユーザーに結び付ける(別ユーザーの行へ移しても復号できない) */
const totpAad = (userId: string) => `users.totp_secret:${userId}`;
