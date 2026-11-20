/** 運営者コンソール(1-19)の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withPlatform, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./auth/password.js";
import { operatorTotpAad } from "./auth/platformAuth.js";
import { createLocalSecretBox } from "./auth/secretBox.js";
import { generateTotpSecret, totpCode, totpStep } from "./auth/totp.js";
import { appRouter } from "./router.js";
import { createHarness, type Harness } from "./testHarness.js";
import { createCallerFactory, PLATFORM_SESSION_COOKIE, type WebContext } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const PASSWORD = "operator password 123";

/** Cookie を覚えるブラウザの代わり */
function browser(): WebContext & { jar: Record<string, string> } {
  const jar: Record<string, string> = {};
  return {
    jar,
    get cookies() {
      return { ...jar };
    },
    setCookie(name, value, { maxAgeSec }) {
      if (maxAgeSec <= 0) delete jar[name];
      else jar[name] = value;
    },
  };
}

describe.skipIf(!url)("運営者コンソール", () => {
  let h: Harness;
  let secret: Buffer;
  let operatorId: string;
  let ops: ReturnType<typeof as>;
  const as = (web: WebContext | null, accessToken: string | null = null) =>
    createCallerFactory(appRouter)({ requestId: "t", services: h.services, accessToken, ip: "10.0.0.5", web });
  const code = (offset = 0) => totpCode(secret, totpStep(h.clock.now) + offset);
  const audits = () => withPlatform(h.db, (tx) => tx.select().from(schema.platformAuditLogs));

  async function signIn(web: ReturnType<typeof browser>, c = code()) {
    const { challengeToken } = await as(web).platform.auth.login({ email: "Ops@Example.com", password: PASSWORD });
    return as(web).platform.auth.verifyTotp({ challengeToken, code: c });
  }

  beforeAll(async () => {
    h = await createHarness("api_platform");
    secret = generateTotpSecret();
    const box = createLocalSecretBox(h.services.config.secretBoxKey);
    operatorId = await withPlatform(h.db, async (tx) => {
      const [op] = await tx.insert(schema.platformOperators).values({ email: "ops@example.com", passwordHash: await hashPassword(PASSWORD) }).returning();
      await tx.update(schema.platformOperators).set({ totpSecretEnc: box.seal(secret, operatorTotpAad(op!.id)) }).where(eq(schema.platformOperators.id, op!.id));
      return op!.id;
    });
    const web = browser();
    await signIn(web);
    ops = as(web);
  });
  afterAll(async () => h?.end());

  describe("ログイン", () => {
    it("パスワード → TOTP でセッションの Cookie(HttpOnly)が付く。同じコードは 2 度使えない", async () => {
      h.clock.now += 60_000;
      const web = browser();
      expect(await codeOf(as(web).platform.auth.me())).toBe("UNAUTHORIZED");
      expect(await signIn(web)).toEqual({ email: "ops@example.com" });
      expect(web.jar[PLATFORM_SESSION_COOKIE]).toBeTruthy();
      expect(await as(web).platform.auth.me()).toEqual({ email: "ops@example.com" });
      expect(await codeOf(signIn(browser()))).toBe("UNAUTHORIZED"); // 再利用
      await as(web).platform.auth.logout();
      expect(web.jar[PLATFORM_SESSION_COOKIE]).toBeUndefined();
    });

    it("パスワード・コードの誤りは UNAUTHORIZED。Web 以外からは受け付けない", async () => {
      h.clock.now += 60_000;
      expect(await codeOf(as(browser()).platform.auth.login({ email: "ops@example.com", password: "wrong password!!" }))).toBe("UNAUTHORIZED");
      expect(await codeOf(as(browser()).platform.auth.login({ email: "nobody@example.com", password: PASSWORD }))).toBe("UNAUTHORIZED");
      expect(await codeOf(signIn(browser(), code(5)))).toBe("UNAUTHORIZED");
      expect(await codeOf(as(null).platform.auth.login({ email: "ops@example.com", password: PASSWORD }))).toBe("BAD_REQUEST");
      const actions = (await audits()).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["operator.login", "operator.login_failed", "operator.totp_failed"]));
    });

    it("テナントのトークンと運営者のトークンは取り違えられない", async () => {
      const tenant = await h.createTenant("T");
      const userToken = await h.accessToken(tenant, await h.createUser(tenant, "t@example.com", "tenant_admin"));
      const web = browser();
      web.jar[PLATFORM_SESSION_COOKIE] = userToken;
      expect(await codeOf(as(web).platform.tenants.list())).toBe("UNAUTHORIZED");
      // 運営者のセッションをテナントの API に使っても通らない
      h.clock.now += 60_000;
      const opWeb = browser();
      await signIn(opWeb);
      expect(await codeOf(as(null, opWeb.jar[PLATFORM_SESSION_COOKIE]!).persons.list({}))).toBe("UNAUTHORIZED");
      // テナントのユーザーは運営者の API を使えない
      expect(await codeOf(as(browser(), userToken).platform.plans.list())).toBe("UNAUTHORIZED");
    });
  });

  describe("プラン", () => {
    it("作成・変更・一覧。モードに合わない項目は保存しない。不正な人数帯は拒否", async () => {
      const { id } = await ops.platform.plans.create({ name: "標準", baseFee: 10_000, billingMode: "per_unit", unitPrice: 300, tiers: [{ upTo: null, unitPrice: 1 }] });
      expect((await ops.platform.plans.list()).find((p) => p.id === id)).toEqual({ id, name: "標準", baseFee: 10_000, billingMode: "per_unit", unitPrice: 300, tiers: null, tenantCount: 0 });
      await ops.platform.plans.update({
        id,
        plan: { name: "標準(段階制)", baseFee: 0, billingMode: "tiered", unitPrice: null, tiers: [{ upTo: 100, unitPrice: 300 }, { upTo: null, unitPrice: 200 }] },
      });
      expect((await ops.platform.plans.list()).find((p) => p.id === id)).toMatchObject({ billingMode: "tiered", unitPrice: null, tiers: [{ upTo: 100 }, { upTo: null }] });
      expect(await codeOf(ops.platform.plans.create({ name: "x", baseFee: 0, billingMode: "tiered", unitPrice: null, tiers: [{ upTo: 100, unitPrice: 1 }] }))).toBe("BAD_REQUEST");
      expect(await codeOf(ops.platform.plans.create({ name: "x", baseFee: 0, billingMode: "per_unit", unitPrice: null, tiers: null }))).toBe("BAD_REQUEST");
      expect(await codeOf(ops.platform.plans.create({ name: "x", baseFee: 1.5, billingMode: "per_unit", unitPrice: 1, tiers: null }))).toBe("BAD_REQUEST");
      expect((await audits()).filter((a) => a.action.startsWith("plan.")).map((a) => a.action)).toEqual(["plan.create", "plan.update"]);
    });
  });

  describe("テナント", () => {
    let tenantId: string;
    let planId: string;

    it("開設すると拠点と招待中のテナント管理者ができ、招待メールが積まれる。招待を受けてログインできる", async () => {
      planId = (await ops.platform.plans.create({ name: "基本", baseFee: 1000, billingMode: "per_unit", unitPrice: 300, tiers: null })).id;
      const r = await ops.platform.tenants.create({ name: "株式会社テスト", adminEmail: "Admin@Corp.example", siteName: "本社", planId, status: "trial" });
      tenantId = r.tenantId;
      expect(r.inviteUrl.startsWith("https://web.example.com/invite#")).toBe(true);
      const { users, sites, outbox, logs } = await withTenant(h.db, tenantId, async (tx) => ({
        users: await tx.select().from(schema.users),
        sites: await tx.select().from(schema.sites),
        outbox: await tx.select().from(schema.notificationOutbox),
        logs: await tx.select().from(schema.auditLogs),
      }));
      expect(users).toMatchObject([{ email: "admin@corp.example", role: "tenant_admin", status: "invited" }]);
      expect(sites.map((s) => s.name)).toEqual(["本社"]);
      expect(outbox.map((o) => o.channel)).toEqual(["email"]);
      expect(logs[0]).toMatchObject({ action: "user.invite", actorId: null, detail: { by: "platform", operatorId } });

      await as(null).auth.acceptInvitation({ token: r.inviteUrl.split("#")[1]!, password: "tenant admin password" });
      const login = await as(null).auth.login({ email: "admin@corp.example", password: "tenant admin password" });
      expect(login.status).toBe("totp_setup_required");
    });

    it("既に使われているメールアドレスでは開設しない(テナントだけ残らない)", async () => {
      const before = (await ops.platform.tenants.list()).length;
      expect(await codeOf(ops.platform.tenants.create({ name: "重複", adminEmail: "admin@corp.example", siteName: "本社", planId: null, status: "trial" }))).toBe("CONFLICT");
      expect((await ops.platform.tenants.list()).length).toBe(before);
    });

    it("一覧は契約と人数だけ(登録者の情報は含まない)", async () => {
      await withTenant(h.db, tenantId, async (tx) => {
        await tx.insert(schema.dailyCounts).values([
          { date: "2033-05-01", activeCount: 4 },
          { date: "2033-05-02", activeCount: 7 },
        ]);
      });
      const row = (await ops.platform.tenants.list()).find((t) => t.id === tenantId)!;
      expect(row).toMatchObject({ name: "株式会社テスト", status: "trial", planName: "基本", latestCountDate: "2033-05-02", latestCount: 7, hasOverride: false });
      expect(Object.keys(row).sort()).toEqual(["createdAt", "hasOverride", "id", "latestCount", "latestCountDate", "name", "planId", "planName", "status"]);
    });

    it("契約状態の変更。未払いにすると起点の日時が入り、戻すと消える", async () => {
      await ops.platform.tenants.update({ id: tenantId, status: "past_due" });
      const t1 = await ops.platform.tenants.get({ id: tenantId });
      expect(t1.pastDueSince).toEqual(new Date(h.clock.now));
      h.clock.now += 1000;
      await ops.platform.tenants.update({ id: tenantId, status: "past_due", name: "株式会社テスト2" }); // 未払いのままなら起点は変えない
      expect((await ops.platform.tenants.get({ id: tenantId })).pastDueSince).toEqual(t1.pastDueSince);
      await ops.platform.tenants.update({ id: tenantId, status: "active" });
      expect((await ops.platform.tenants.get({ id: tenantId })).pastDueSince).toBeNull();
      expect(await codeOf(ops.platform.tenants.update({ id: tenantId, planId: "00000000-0000-4000-8000-000000000000" }))).toBe("BAD_REQUEST");
      expect(await codeOf(ops.platform.tenants.update({ id: tenantId, retentionYears: 6 }))).toBe("BAD_REQUEST");
    });

    it("個別単価はテナントの請求計算に効き、解除できる", async () => {
      const admin = await h.callerAs(tenantId, await h.createUser(tenantId, "admin2@corp.example", "tenant_admin"));
      expect((await admin.billing.summary({})).pricing).toEqual({ baseFee: 1000, mode: "per_unit", unitPrice: 300 });
      await ops.platform.tenants.setPriceOverride({ tenantId, override: { planId: null, baseFee: 0, unitPrice: 150, tiers: null } });
      expect((await admin.billing.summary({})).pricing).toEqual({ baseFee: 0, mode: "per_unit", unitPrice: 150 });
      expect((await ops.platform.tenants.get({ id: tenantId })).override).toEqual({ planId: null, baseFee: 0, unitPrice: 150, tiers: null });
      expect(await codeOf(ops.platform.tenants.setPriceOverride({ tenantId, override: { planId: null, baseFee: null, unitPrice: 1, tiers: [{ upTo: null, unitPrice: 1 }] } }))).toBe("BAD_REQUEST");
      await ops.platform.tenants.setPriceOverride({ tenantId, override: null });
      expect((await admin.billing.summary({})).pricing).toEqual({ baseFee: 1000, mode: "per_unit", unitPrice: 300 });
      expect((await ops.platform.tenants.get({ id: tenantId })).override).toBeNull();
    });

    it("唯一のテナント管理者の認証アプリを運営者がリセットできる(テナント管理者以外は対象外)", async () => {
      expect(await ops.platform.tenants.resetAdminTotp({ tenantId, email: "admin@corp.example" })).toEqual({ ok: true });
      expect(await codeOf(ops.platform.tenants.resetAdminTotp({ tenantId, email: "nobody@corp.example" }))).toBe("NOT_FOUND");
      const logs = await withTenant(h.db, tenantId, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "user.totp_reset")));
      expect(logs[0]?.detail).toMatchObject({ by: "platform", operatorId });
      expect((await audits()).some((a) => a.action === "tenant.reset_admin_totp")).toBe(true);
    });

    it("テナント管理者の再招待", async () => {
      const r = await ops.platform.tenants.inviteAdmin({ tenantId, email: "second@corp.example" });
      expect(r.inviteUrl).toContain("/invite#");
      expect(await codeOf(ops.platform.tenants.inviteAdmin({ tenantId, email: "admin@corp.example" }))).toBe("CONFLICT"); // 有効なユーザー
      await ops.platform.tenants.inviteAdmin({ tenantId, email: "second@corp.example" }); // 招待中なら再発行
    });
  });

  it("停止した運営者のセッションは次のリクエストから通らない", async () => {
    await withPlatform(h.db, (tx) => tx.update(schema.platformOperators).set({ disabledAt: new Date() }).where(eq(schema.platformOperators.id, operatorId)));
    expect(await codeOf(ops.platform.tenants.list())).toBe("UNAUTHORIZED");
  });
});
