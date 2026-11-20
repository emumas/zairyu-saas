/**
 * 運営者の認証(1-19)。メール+パスワード+TOTP(必須)。
 * - 運営者はテナントに属さず、DB には zairyu_platform ロールでアクセスする
 * - アカウントは CLI(scripts/createOperator.ts)で作り、その場で TOTP を設定する(画面からの初期設定は無い)
 * - 失敗は一律 UNAUTHORIZED。ログイン失敗と TOTP の失敗を合算して数え、上限で一定時間ロックする
 * - セッションは 2 時間の JWT(HttpOnly Cookie)。停止した運営者は次のリクエストから通らない
 */
import { schema, withPlatform, type Db, type Tx } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { verifyPassword } from "./password.js";
import type { SecretBox } from "./secretBox.js";
import { verifyTotp } from "./totp.js";
import { signPlatformToken, verifyPlatformToken } from "./tokens.js";

const { platformOperators, platformAuditLogs } = schema;

export const PLATFORM_SESSION_TTL_SEC = 2 * 3600;

const fail = () => new TRPCError({ code: "UNAUTHORIZED", message: "メールアドレス・パスワードまたは確認コードが正しくありません" });
const expired = () => new TRPCError({ code: "UNAUTHORIZED", message: "セッションの有効期限が切れました。もう一度ログインしてください" });

/** TOTP の秘密鍵を暗号化するときの付加データ(他の行・用途の暗号文を流用させない) */
export const operatorTotpAad = (operatorId: string) => `platform_operators.totp_secret:${operatorId}`;

export interface Operator {
  id: string;
  email: string;
}

export class PlatformAuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now,
  ) {}

  private nowSec() {
    return Math.floor(this.now() / 1000);
  }

  private async load(tx: Tx, where: { id: string } | { email: string }) {
    const [op] = await tx
      .select()
      .from(platformOperators)
      .where("id" in where ? eq(platformOperators.id, where.id) : eq(platformOperators.email, where.email));
    return op ?? null;
  }

  private isLocked(op: { lockedUntil: Date | null }) {
    return op.lockedUntil !== null && op.lockedUntil.getTime() > this.now();
  }

  private async recordFailure(tx: Tx, id: string, current: number) {
    const count = current + 1;
    const lock = count >= this.config.maxFailedLogins;
    await tx
      .update(platformOperators)
      .set({ failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(this.now() + this.config.lockoutSec * 1000) : null })
      .where(eq(platformOperators.id, id));
  }

  private async audit(tx: Tx, operatorId: string | null, action: string, ip: string | null) {
    await tx.insert(platformAuditLogs).values({ operatorId, action, ip });
  }

  /** 1 段目: パスワード。合えば TOTP 入力用のトークンを返す */
  async login(emailInput: string, password: string, ip: string | null): Promise<{ challengeToken: string }> {
    const email = emailInput.trim().toLowerCase();
    const id = await withPlatform(this.db, async (tx) => {
      const op = await this.load(tx, { email });
      if (!op) {
        await verifyPassword(null, password); // 応答時間をそろえる
        return null;
      }
      if (this.isLocked(op) || op.disabledAt || !op.totpSecretEnc) {
        await verifyPassword(null, password);
        await this.audit(tx, op.id, "operator.login_rejected", ip);
        return null;
      }
      if (!(await verifyPassword(op.passwordHash, password))) {
        await this.recordFailure(tx, op.id, op.failedLoginCount);
        await this.audit(tx, op.id, "operator.login_failed", ip);
        return null;
      }
      return op.id;
    });
    if (!id) throw fail();
    return { challengeToken: await signPlatformToken(this.config.jwtSecret, id, "op_challenge", this.config.purposeTokenTtlSec, this.nowSec()) };
  }

  /** 2 段目: 認証アプリのコード。合えばセッションのトークンを返す */
  async verifyTotp(challengeToken: string, code: string, ip: string | null): Promise<{ sessionToken: string; operator: Operator }> {
    const id = await verifyPlatformToken(this.config.jwtSecret, challengeToken, "op_challenge", this.nowSec());
    if (!id) throw expired();
    const op = await withPlatform(this.db, async (tx) => {
      const op = await this.load(tx, { id });
      if (!op || op.disabledAt || !op.totpSecretEnc || this.isLocked(op)) return null;
      const step = verifyTotp(this.box.open(op.totpSecretEnc, operatorTotpAad(op.id)), code, this.now(), op.totpLastStep);
      if (step === null) {
        await this.recordFailure(tx, op.id, op.failedLoginCount);
        await this.audit(tx, op.id, "operator.totp_failed", ip);
        return null;
      }
      await tx.update(platformOperators).set({ totpLastStep: step, failedLoginCount: 0, lockedUntil: null }).where(eq(platformOperators.id, op.id));
      await this.audit(tx, op.id, "operator.login", ip);
      return { id: op.id, email: op.email };
    });
    if (!op) throw fail();
    return { sessionToken: await signPlatformToken(this.config.jwtSecret, op.id, "op_session", PLATFORM_SESSION_TTL_SEC, this.nowSec()), operator: op };
  }

  /** セッションの確認(毎リクエスト)。停止中・削除済みなら null */
  async authenticate(sessionToken: string): Promise<Operator | null> {
    const id = await verifyPlatformToken(this.config.jwtSecret, sessionToken, "op_session", this.nowSec());
    if (!id) return null;
    return withPlatform(this.db, async (tx) => {
      const op = await this.load(tx, { id });
      return op && !op.disabledAt ? { id: op.id, email: op.email } : null;
    });
  }
}
