/**
 * 認証と権限の結合テスト(実際の PostgreSQL)。TEST_DATABASE_URL が無ければスキップ。
 * 同じサーバーに <DB名>_api を作って使う。
 */
import { randomBytes } from "node:crypto";
import { createDb, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "./auth/password.js";
import { createLocalSecretBox } from "./auth/secretBox.js";
import { AuthService } from "./auth/service.js";
import { base32Decode, totpCode, totpStep } from "./auth/totp.js";
import type { Config } from "./config.js";
import { RateLimiter } from "./rateLimit.js";
import { appRouter } from "./router.js";
import { createCallerFactory, permissionProcedure, router, type Context, type Services } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";

describe.skipIf(!url)("認証と権限(結合)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let services: Services;
  let clock = 1_800_000_000_000;
  let tenantId: string;
  let otherTenantId: string;
  let siteA: string;
  let siteB: string;

  const config: Config = {
    databaseUrl: undefined,
    jwtSecret: new TextEncoder().encode("test-secret-".repeat(4)),
    secretBoxKey: randomBytes(32),
    totpIssuer: "test",
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 3600,
    purposeTokenTtlSec: 300,
    maxFailedLogins: 10,
    lockoutSec: 900,
    publicBaseUrl: "https://api.example.com",
    imageUrlTtlSec: 120,
  };

  const caller = (accessToken: string | null = null) => {
    const ctx: Context = { requestId: "t", services, accessToken, ip: "127.0.0.1" };
    return createCallerFactory(appRouter)(ctx);
  };

  async function createUser(email: string, role: "tenant_admin" | "site_admin" | "viewer", sites: string[] = [], tid = tenantId) {
    const passwordHash = await hashPassword(PASSWORD);
    return withTenant(db, tid, async (tx) => {
      const [u] = await tx.insert(schema.users).values({ email, role, status: "active", passwordHash }).returning();
      for (const siteId of sites) await tx.insert(schema.userSites).values({ userId: u!.id, siteId });
      return u!.id;
    });
  }

  /** TOTP 有効化まで済ませたユーザーのログイン(秘密鍵を返す) */
  async function enrollTotp(email: string): Promise<{ secret: Buffer; tokens: { accessToken: string; refreshToken: string } }> {
    const r = await caller().auth.login({ email, password: PASSWORD });
    if (r.status !== "totp_setup_required") throw new Error(`unexpected ${r.status}`);
    const setup = await caller().auth.beginTotpSetup({ setupToken: r.setupToken });
    const secret = base32Decode(setup.secret);
    const tokens = await caller().auth.confirmTotpSetup({ setupToken: r.setupToken, code: totpCode(secret, totpStep(clock)) });
    return { secret, tokens };
  }

  const codeOf = (e: unknown) => (e instanceof TRPCError ? e.code : String(e));
  const expectCode = async (p: Promise<unknown>, code: string) => expect(codeOf(await p.then(() => "ok", (e: unknown) => e))).toBe(code);

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, "api");
    const c = createDb(testUrl, { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    const now = () => clock;
    services = {
      db,
      config,
      now,
      auth: new AuthService(db, config, createLocalSecretBox(config.secretBoxKey), now),
      authRateLimiter: new RateLimiter(1000, 60_000, now),
      vault: null,
    };
    [tenantId, otherTenantId] = await withPlatform(db, async (tx) => {
      const rows = await tx.insert(schema.tenants).values([{ name: "A社", status: "active" }, { name: "B社", status: "active" }]).returning();
      return rows.map((r) => r.id) as [string, string];
    });
    [siteA, siteB] = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx.insert(schema.sites).values([{ name: "東京" }, { name: "大阪" }]).returning();
      return rows.map((r) => r.id) as [string, string];
    });
  });

  afterAll(async () => {
    await end?.();
  });

  beforeEach(() => {
    clock += 10 * 60_000; // テストごとに時刻を進め、TOTP のステップが重ならないようにする
  });

  describe("ログイン", () => {
    it("閲覧者は TOTP なしでログインでき、me で担当拠点だけが見える", async () => {
      await createUser("viewer@example.com", "viewer", [siteB]);
      const r = await caller().auth.login({ email: "Viewer@Example.com ", password: PASSWORD });
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      const me = await caller(r.accessToken).me.get();
      expect(me.role).toBe("viewer");
      expect(me.sites).toEqual([{ id: siteB, name: "大阪" }]);
      expect(me.permissions).not.toContain("cards.viewImage");
    });

    it("パスワード違いと存在しないユーザーは同じエラー", async () => {
      await createUser("wrong@example.com", "viewer");
      const a = await caller().auth.login({ email: "wrong@example.com", password: "nope" }).catch((e: unknown) => e);
      const b = await caller().auth.login({ email: "none@example.com", password: "nope" }).catch((e: unknown) => e);
      expect(codeOf(a)).toBe("UNAUTHORIZED");
      expect((a as Error).message).toBe((b as Error).message);
    });

    it("管理者は初回に TOTP 設定が必要で、以後は TOTP を求められる", async () => {
      await createUser("admin@example.com", "tenant_admin");
      const { secret, tokens } = await enrollTotp("admin@example.com");
      expect((await caller(tokens.accessToken).me.get()).role).toBe("tenant_admin");

      clock += 60_000;
      const r = await caller().auth.login({ email: "admin@example.com", password: PASSWORD });
      expect(r.status).toBe("totp_required");
      if (r.status !== "totp_required") return;
      await expectCode(caller().auth.verifyTotp({ challengeToken: r.challengeToken, code: "000000" }), "UNAUTHORIZED");
      const ok = await caller().auth.verifyTotp({ challengeToken: r.challengeToken, code: totpCode(secret, totpStep(clock)) });
      expect(ok.accessToken).toBeTruthy();

      // 同じコードの再利用は拒否
      const again = await caller().auth.login({ email: "admin@example.com", password: PASSWORD });
      if (again.status !== "totp_required") throw new Error("unexpected");
      await expectCode(caller().auth.verifyTotp({ challengeToken: again.challengeToken, code: totpCode(secret, totpStep(clock)) }), "UNAUTHORIZED");
    });

    it("TOTP 必須のロールは、設定を済ませるまでアクセストークンを得られない", async () => {
      await createUser("site@example.com", "site_admin", [siteA]);
      const r = await caller().auth.login({ email: "site@example.com", password: PASSWORD });
      expect(r.status).toBe("totp_setup_required");
      expect("accessToken" in r).toBe(false);
    });

    it("TOTP 用のトークンはアクセストークンとして使えない", async () => {
      await createUser("admin2@example.com", "tenant_admin");
      const r = await caller().auth.login({ email: "admin2@example.com", password: PASSWORD });
      if (r.status !== "totp_setup_required") throw new Error("unexpected");
      await expectCode(caller(r.setupToken).me.get(), "UNAUTHORIZED");
    });

    it("10 回失敗するとロックされ、正しいパスワードでも 15 分は入れない", async () => {
      await createUser("lock@example.com", "viewer");
      for (let i = 0; i < 10; i++) await expectCode(caller().auth.login({ email: "lock@example.com", password: "bad" }), "UNAUTHORIZED");
      await expectCode(caller().auth.login({ email: "lock@example.com", password: PASSWORD }), "UNAUTHORIZED");
      clock += 16 * 60_000;
      expect((await caller().auth.login({ email: "lock@example.com", password: PASSWORD })).status).toBe("ok");
    });

    it("ログインの成否を監査ログに残す(パスワード等は残さない)", async () => {
      const id = await createUser("audit@example.com", "viewer");
      await caller().auth.login({ email: "audit@example.com", password: "bad" }).catch(() => {});
      await caller().auth.login({ email: "audit@example.com", password: PASSWORD });
      const logs = await withTenant(db, tenantId, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.actorId, id)));
      expect(logs.map((l) => l.action).sort()).toEqual(["auth.login", "auth.login_failed"]);
      expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    });
  });

  describe("リフレッシュトークン", () => {
    it("ローテーションし、使用済みの再利用で family ごと失効する", async () => {
      await createUser("refresh@example.com", "viewer");
      const r = await caller().auth.login({ email: "refresh@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      const second = await caller().auth.refresh({ refreshToken: r.refreshToken });
      expect(second.refreshToken).not.toBe(r.refreshToken);
      // 古いトークンの再利用 → 盗用とみなして新しいほうも失効
      await expectCode(caller().auth.refresh({ refreshToken: r.refreshToken }), "UNAUTHORIZED");
      await expectCode(caller().auth.refresh({ refreshToken: second.refreshToken }), "UNAUTHORIZED");
    });

    it("ログアウトで失効する", async () => {
      await createUser("logout@example.com", "viewer");
      const r = await caller().auth.login({ email: "logout@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      await caller().auth.logout({ refreshToken: r.refreshToken });
      await expectCode(caller().auth.refresh({ refreshToken: r.refreshToken }), "UNAUTHORIZED");
    });

    it("期限切れは使えない", async () => {
      await createUser("expire@example.com", "viewer");
      const r = await caller().auth.login({ email: "expire@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      clock += 3601_000;
      await expectCode(caller().auth.refresh({ refreshToken: r.refreshToken }), "UNAUTHORIZED");
    });

    it("テナント部分を書き換えたトークンは使えない", async () => {
      await createUser("tamper@example.com", "viewer");
      const r = await caller().auth.login({ email: "tamper@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      const forged = `${otherTenantId}.${r.refreshToken.split(".")[1]}`;
      await expectCode(caller().auth.refresh({ refreshToken: forged }), "UNAUTHORIZED");
    });
  });

  describe("権限ミドルウェア", () => {
    const testRouter = router({
      orgOnly: permissionProcedure("org.manage").query(() => "ok"),
      cardsOnly: permissionProcedure("cards.write").query(() => "ok"),
    });
    const testCaller = (token: string) =>
      createCallerFactory(testRouter)({ requestId: "t", services, accessToken: token, ip: "127.0.0.1" });

    it("ロールに応じて手続きを拒否する", async () => {
      await createUser("perm-viewer@example.com", "viewer");
      const r = await caller().auth.login({ email: "perm-viewer@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      await expectCode(testCaller(r.accessToken).orgOnly(), "FORBIDDEN");
      await expectCode(testCaller(r.accessToken).cardsOnly(), "FORBIDDEN");
    });

    it("ロールの変更と利用停止はトークンの期限を待たずに反映される", async () => {
      const id = await createUser("promote@example.com", "viewer");
      const r = await caller().auth.login({ email: "promote@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      await withTenant(db, tenantId, (tx) => tx.update(schema.users).set({ role: "tenant_admin" }).where(eq(schema.users.id, id)));
      expect(await testCaller(r.accessToken).orgOnly()).toBe("ok");
      await withTenant(db, tenantId, (tx) => tx.update(schema.users).set({ status: "suspended" }).where(eq(schema.users.id, id)));
      await expectCode(testCaller(r.accessToken).orgOnly(), "UNAUTHORIZED");
    });

    it("契約停止中のテナントは使えない", async () => {
      await createUser("suspended@example.com", "viewer", [], otherTenantId);
      const r = await caller().auth.login({ email: "suspended@example.com", password: PASSWORD });
      if (r.status !== "ok") throw new Error("unexpected");
      await withPlatform(db, (tx) => tx.update(schema.tenants).set({ status: "suspended" }).where(eq(schema.tenants.id, otherTenantId)));
      await expectCode(caller(r.accessToken).me.get(), "FORBIDDEN");
      await expectCode(caller().auth.login({ email: "suspended@example.com", password: PASSWORD }), "UNAUTHORIZED");
    });

    it("トークンなし・不正なトークンは UNAUTHORIZED", async () => {
      await expectCode(caller().me.get(), "UNAUTHORIZED");
      await expectCode(caller("garbage").me.get(), "UNAUTHORIZED");
    });
  });
});
