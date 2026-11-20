/** パスワード再設定・変更、認証アプリの付け替え・リセット。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./auth/password.js";
import { createLocalSecretBox } from "./auth/secretBox.js";
import { base32Decode, generateTotpSecret, totpCode, totpStep } from "./auth/totp.js";
import { appRouter } from "./router.js";
import { createHarness, type Harness } from "./testHarness.js";
import { createCallerFactory } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const PASSWORD = "first password 123";

describe.skipIf(!url)("アカウントの回復", () => {
  let h: Harness;
  let tenant: string;
  const pub = () => createCallerFactory(appRouter)({ requestId: "t", services: h.services, accessToken: null, ip: "10.0.0.7" });
  const withToken = (accessToken: string) => createCallerFactory(appRouter)({ requestId: "t", services: h.services, accessToken, ip: "10.0.0.7" });

  async function user(email: string, role: "tenant_admin" | "site_admin" | "viewer", totp?: Buffer) {
    const id = await h.createUser(tenant, email, role);
    const box = createLocalSecretBox(h.services.config.secretBoxKey);
    await withTenant(h.db, tenant, async (tx) =>
      tx
        .update(schema.users)
        .set({ passwordHash: await hashPassword(PASSWORD), ...(totp ? { totpEnabled: true, totpSecretEnc: box.seal(totp, `users.totp_secret:${id}`) } : {}) })
        .where(eq(schema.users.id, id)),
    );
    return id;
  }
  /** 送信待ちのメールから再設定のトークンを取り出す */
  const resetTokenFor = async (userId: string) => {
    const rows = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.userId, userId)));
    const body = rows.map((r) => (r.payload as { body: string }).body).find((b) => b.includes("/reset-password#"));
    return body?.match(/reset-password#(\S+)/)?.[1] ?? null;
  };
  const activeRefreshTokens = (userId: string) =>
    withTenant(h.db, tenant, (tx) =>
      tx
        .select()
        .from(schema.refreshTokens)
        .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt), isNull(schema.refreshTokens.usedAt))),
    );

  beforeAll(async () => {
    h = await createHarness("api_recovery");
    tenant = await h.createTenant("A");
  });
  afterAll(async () => h?.end());

  describe("パスワードを忘れた場合", () => {
    it("登録の有無にかかわらず同じ応答。リンクで再設定すると全端末のログインが失効し、新しいパスワードで入れる", async () => {
      const id = await user("forgot@example.com", "viewer");
      const first = await pub().auth.login({ email: "forgot@example.com", password: PASSWORD });
      expect(first.status).toBe("ok");
      expect(await pub().auth.requestPasswordReset({ email: "nobody@example.com" })).toEqual({ ok: true });
      expect(await pub().auth.requestPasswordReset({ email: "Forgot@Example.com" })).toEqual({ ok: true });
      const token = (await resetTokenFor(id))!;
      expect(token).toBeTruthy();

      expect(await codeOf(pub().auth.resetPassword({ token, password: "short" }))).toBe("BAD_REQUEST");
      expect(await pub().auth.resetPassword({ token, password: "second password 456" })).toEqual({ email: "forgot@example.com" });
      expect(await activeRefreshTokens(id)).toHaveLength(0);
      expect(await codeOf(pub().auth.resetPassword({ token, password: "third password 789" }))).toBe("BAD_REQUEST"); // 1 回限り
      expect(await codeOf(pub().auth.login({ email: "forgot@example.com", password: PASSWORD }))).toBe("UNAUTHORIZED");
      expect((await pub().auth.login({ email: "forgot@example.com", password: "second password 456" })).status).toBe("ok");
      // 本人に「パスワードが変更されました」の知らせ
      const mails = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.userId, id)));
      expect(mails.map((m) => (m.payload as { kind: string }).kind)).toContain("security");
    });

    it("リンクは 1 時間で切れる。同じ人への発行は 1 時間に 3 回まで", async () => {
      const id = await user("limit@example.com", "viewer");
      for (let i = 0; i < 5; i++) await pub().auth.requestPasswordReset({ email: "limit@example.com" });
      const issued = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, id)));
      expect(issued).toHaveLength(3);
      const token = (await resetTokenFor(id))!;
      h.clock.now += 3601_000;
      expect(await codeOf(pub().auth.resetPassword({ token, password: "second password 456" }))).toBe("BAD_REQUEST");
    });

    it("再設定しても認証アプリ(二要素)は外れない", async () => {
      const secret = generateTotpSecret();
      const id = await user("admin-forgot@example.com", "tenant_admin", secret);
      await pub().auth.requestPasswordReset({ email: "admin-forgot@example.com" });
      await pub().auth.resetPassword({ token: (await resetTokenFor(id))!, password: "second password 456" });
      expect((await pub().auth.login({ email: "admin-forgot@example.com", password: "second password 456" })).status).toBe("totp_required");
    });
  });

  describe("ログイン中の変更", () => {
    it("パスワード変更: 今のパスワードが必要。ほかの端末は失効し、この端末には新しいトークン", async () => {
      const id = await user("change@example.com", "viewer");
      const a = await pub().auth.login({ email: "change@example.com", password: PASSWORD });
      const b = await pub().auth.login({ email: "change@example.com", password: PASSWORD });
      if (a.status !== "ok" || b.status !== "ok") throw new Error("login");
      expect(await codeOf(withToken(a.accessToken).auth.changePassword({ currentPassword: "wrong password 000", newPassword: "new password 999" }))).toBe("BAD_REQUEST");
      const pair = await withToken(a.accessToken).auth.changePassword({ currentPassword: PASSWORD, newPassword: "new password 999" });
      expect(await codeOf(pub().auth.refresh({ refreshToken: b.refreshToken }))).toBe("UNAUTHORIZED");
      expect(await pub().auth.refresh({ refreshToken: pair.refreshToken })).toHaveProperty("accessToken");
      expect(await activeRefreshTokens(id)).toHaveLength(1);
    });

    it("認証アプリの付け替え: パスワードと今のコードが必要。新しいコードで確定するまで切り替わらない", async () => {
      const oldSecret = generateTotpSecret();
      const id = await user("phone@example.com", "site_admin", oldSecret);
      const access = await h.accessToken(tenant, id);
      const me = withToken(access);
      expect(await codeOf(me.auth.beginTotpChange({ password: PASSWORD, code: "000000" }))).toBe("BAD_REQUEST");
      h.clock.now += 60_000;
      const begun = await me.auth.beginTotpChange({ password: PASSWORD, code: totpCode(oldSecret, totpStep(h.clock.now)) });
      const newSecret = base32Decode(begun.secret);
      // 確定前は古いコードのまま
      expect(await codeOf(me.auth.confirmTotpChange({ changeToken: begun.changeToken, code: totpCode(oldSecret, totpStep(h.clock.now)) }))).toBe("BAD_REQUEST");
      await me.auth.confirmTotpChange({ changeToken: begun.changeToken, code: totpCode(newSecret, totpStep(h.clock.now)) });
      // 新しい認証アプリでログインできる
      h.clock.now += 60_000;
      const l = await pub().auth.login({ email: "phone@example.com", password: PASSWORD });
      if (l.status !== "totp_required") throw new Error(l.status);
      expect(await codeOf(pub().auth.verifyTotp({ challengeToken: l.challengeToken, code: totpCode(oldSecret, totpStep(h.clock.now)) }))).toBe("UNAUTHORIZED");
      h.clock.now += 30_000;
      const l2 = await pub().auth.login({ email: "phone@example.com", password: PASSWORD });
      if (l2.status !== "totp_required") throw new Error(l2.status);
      expect(await pub().auth.verifyTotp({ challengeToken: l2.challengeToken, code: totpCode(newSecret, totpStep(h.clock.now)) })).toHaveProperty("accessToken");
      // ほかのユーザーの付け替えトークンは使えない
      const other = await user("other-phone@example.com", "viewer");
      expect(await codeOf(withToken(await h.accessToken(tenant, other)).auth.confirmTotpChange({ changeToken: begun.changeToken, code: "123456" }))).toBe("UNAUTHORIZED");
    });
  });

  describe("管理者による回復", () => {
    it("認証アプリのリセット: 次のログインで設定し直す。全端末のログインを失効。自分自身はリセットできない", async () => {
      const adminId = await user("admin@example.com", "tenant_admin", generateTotpSecret());
      const admin = withToken(await h.accessToken(tenant, adminId));
      const lost = await user("lost@example.com", "site_admin", generateTotpSecret());
      await admin.org.users.resetTotp({ userId: lost });
      expect((await pub().auth.login({ email: "lost@example.com", password: PASSWORD })).status).toBe("totp_setup_required");
      expect(await activeRefreshTokens(lost)).toHaveLength(0);
      expect(await codeOf(admin.org.users.resetTotp({ userId: adminId }))).toBe("BAD_REQUEST");
      const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "user.totp_reset")));
      expect(logs.map((l) => l.targetId)).toContain(lost);
      // 拠点管理者はできない
      expect(await codeOf(withToken(await h.accessToken(tenant, lost)).org.users.resetTotp({ userId: adminId }))).toBe("FORBIDDEN");
    });

    it("管理者がパスワード再設定のリンクを発行できる(メールが届かないとき用)", async () => {
      const adminId = await user("admin2@example.com", "tenant_admin");
      const target = await user("needs-reset@example.com", "viewer");
      const r = await withToken(await h.accessToken(tenant, adminId)).org.users.issuePasswordReset({ userId: target });
      expect(r.url).toContain("/reset-password#");
      await pub().auth.resetPassword({ token: r.url.split("#")[1]!, password: "admin issued 1234" });
      expect((await pub().auth.login({ email: "needs-reset@example.com", password: "admin issued 1234" })).status).toBe("ok");
    });
  });
});
