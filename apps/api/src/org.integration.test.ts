/** 組織管理(1-15)・招待・Web の Cookie の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./auth/password.js";
import { appRouter } from "./router.js";
import { REFRESH_COOKIE } from "./routers/auth.js";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";
import { createCallerFactory, type WebContext } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const PASSWORD = "correct horse battery staple";

describe.skipIf(!url)("組織管理と招待", () => {
  let h: Harness;
  let tenant: string;
  let tokyo: string;
  let adminId: string;
  let admin: AppCaller;
  let siteAdmin: AppCaller;
  const publicCaller = (web?: WebContext) =>
    createCallerFactory(appRouter)({ requestId: "t", services: h.services, accessToken: null, ip: "10.0.0.9", ...(web ? { web } : {}) });

  beforeAll(async () => {
    h = await createHarness("api_org");
    tenant = await h.createTenant("A");
    tokyo = await h.createSite(tenant, "東京");
    adminId = await h.createUser(tenant, "admin@example.com", "tenant_admin");
    admin = await h.callerAs(tenant, adminId);
    siteAdmin = await h.callerAs(tenant, await h.createUser(tenant, "site@example.com", "site_admin", [tokyo]));
  });
  afterAll(async () => h?.end());

  it("拠点の追加・名前変更・アーカイブ。アーカイブした拠点には登録者を追加できない", async () => {
    const { id } = await admin.org.sites.create({ name: "大阪" });
    await admin.org.sites.update({ id, name: "大阪本社" });
    expect((await admin.org.sites.list()).map((s) => s.name)).toEqual(["大阪本社", "東京"]);
    await admin.org.sites.update({ id, archived: true });
    expect(await codeOf(admin.persons.create({ siteId: id, employeeCode: "X", name: "x" }))).toBe("BAD_REQUEST");
  });

  it("拠点管理者は組織管理を使えない", async () => {
    expect(await codeOf(siteAdmin.org.users.list())).toBe("FORBIDDEN");
    expect(await codeOf(siteAdmin.org.sites.create({ name: "x" }))).toBe("FORBIDDEN");
  });

  it("招待 → パスワード設定 → ログインできる。招待リンクは 1 回だけ使える", async () => {
    const r = await admin.org.users.invite({ email: "New.User@Example.com", role: "viewer", siteIds: [tokyo] });
    expect(r.inviteUrl.startsWith("https://web.example.com/invite#")).toBe(true);
    const token = r.inviteUrl.split("#")[1]!;
    const users = await admin.org.users.list();
    expect(users.find((u) => u.id === r.userId)).toMatchObject({ email: "new.user@example.com", status: "invited", siteIds: [tokyo] });

    // 招待メールが送信待ちに積まれる
    const outbox = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.userId, r.userId)));
    expect(outbox.map((o) => o.channel)).toEqual(["email"]);

    expect(await codeOf(publicCaller().auth.acceptInvitation({ token, password: "short" }))).toBe("BAD_REQUEST");
    expect(await publicCaller().auth.acceptInvitation({ token, password: PASSWORD })).toEqual({ email: "new.user@example.com" });
    expect(await codeOf(publicCaller().auth.acceptInvitation({ token, password: PASSWORD }))).toBe("BAD_REQUEST");
    expect((await publicCaller().auth.login({ email: "new.user@example.com", password: PASSWORD })).status).toBe("ok");
  });

  it("再招待すると以前のリンクは使えない。期限切れも使えない", async () => {
    const r = await admin.org.users.invite({ email: "re@example.com", role: "viewer", siteIds: [] });
    const r2 = await admin.org.users.reinvite({ userId: r.userId });
    expect(await codeOf(publicCaller().auth.acceptInvitation({ token: r.inviteUrl.split("#")[1]!, password: PASSWORD }))).toBe("BAD_REQUEST");
    h.clock.now += 73 * 3600 * 1000;
    expect(await codeOf(publicCaller().auth.acceptInvitation({ token: r2.inviteUrl.split("#")[1]!, password: PASSWORD }))).toBe("BAD_REQUEST");
    h.clock.now -= 73 * 3600 * 1000; // 後続のテストのアクセストークンが切れないよう戻す
  });

  it("同じメールアドレスは招待できない", async () => {
    expect(await codeOf(admin.org.users.invite({ email: "site@example.com", role: "viewer", siteIds: [] }))).toBe("CONFLICT");
  });

  it("自分自身の停止・降格はできず、最後のテナント管理者は降格・停止できない", async () => {
    expect(await codeOf(admin.org.users.setActive({ userId: adminId, active: false }))).toBe("BAD_REQUEST");
    expect(await codeOf(admin.org.users.update({ userId: adminId, role: "viewer" }))).toBe("BAD_REQUEST");
    // もう 1 人の管理者からも、最後の 1 人は降格できない
    const second = await h.createUser(tenant, "admin2@example.com", "tenant_admin");
    const admin2 = await h.callerAs(tenant, second);
    await admin.org.users.setActive({ userId: second, active: false });
    expect(await codeOf(admin2.org.users.list())).toBe("UNAUTHORIZED"); // 停止は即時に効く
    await admin.org.users.setActive({ userId: second, active: true });
    await admin2.org.users.update({ userId: adminId, role: "site_admin", siteIds: [tokyo] });
    expect(await codeOf(admin2.org.users.update({ userId: second, role: "viewer" }))).toBe("BAD_REQUEST"); // 自分
    expect((await admin2.me.get()).role).toBe("tenant_admin");
    // 元に戻す
    await admin2.org.users.update({ userId: adminId, role: "tenant_admin" });
  });

  it("停止するとリフレッシュトークンも失効する", async () => {
    const id = await withTenant(h.db, tenant, async (tx) => {
      const [u] = await tx.insert(schema.users).values({ email: "stop@example.com", role: "viewer", status: "active", passwordHash: await hashPassword(PASSWORD) }).returning();
      return u!.id;
    });
    const r = await publicCaller().auth.login({ email: "stop@example.com", password: PASSWORD });
    if (r.status !== "ok") throw new Error("unexpected");
    await admin.org.users.setActive({ userId: id, active: false });
    expect(await codeOf(publicCaller().auth.refresh({ refreshToken: r.refreshToken }))).toBe("UNAUTHORIZED");
  });

  it("Web: リフレッシュトークンは HttpOnly Cookie に入り、応答には含めない", async () => {
    await withTenant(h.db, tenant, async (tx) => {
      await tx.insert(schema.users).values({ email: "web@example.com", role: "viewer", status: "active", passwordHash: await hashPassword(PASSWORD) });
    });
    const jar: Record<string, string> = {};
    const set: { name: string; value: string; path: string; maxAgeSec: number }[] = [];
    const web: WebContext = {
      cookies: jar,
      setCookie(name, value, o) {
        set.push({ name, value, ...o });
        if (o.maxAgeSec > 0) jar[name] = value;
        else delete jar[name];
      },
    };
    const r = await publicCaller(web).auth.login({ email: "web@example.com", password: PASSWORD });
    if (r.status !== "ok") throw new Error("unexpected");
    expect(r.refreshToken).toBe("");
    expect(set[0]).toMatchObject({ name: REFRESH_COOKIE, path: "/trpc/auth" });
    const before = jar[REFRESH_COOKIE];
    const refreshed = await publicCaller(web).auth.refresh({});
    expect(refreshed.accessToken).toBeTruthy();
    expect(jar[REFRESH_COOKIE]).not.toBe(before); // ローテーション
    await publicCaller(web).auth.logout({});
    expect(jar[REFRESH_COOKIE]).toBeUndefined();
    expect(await codeOf(publicCaller(web).auth.refresh({}))).toBe("UNAUTHORIZED");
  });
});
