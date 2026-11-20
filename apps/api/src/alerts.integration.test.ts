/** アラート API と要確認の即時通知(1-13)。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { toBase64, type EfPath } from "@zairyu/zairyu-ic";
import { buildCardFiles, makeCertAndKey } from "@zairyu/zairyu-ic/testing";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("アラート API", () => {
  let h: Harness;
  let tenant: string;
  let tokyo: string;
  let osaka: string;
  let admin: AppCaller;
  let tokyoAdmin: AppCaller;
  let osakaAdmin: AppCaller;
  let viewer: AppCaller;
  const ids = { admin: "", tokyo: "", osaka: "" };
  const ec = makeCertAndKey("ec");

  beforeAll(async () => {
    h = await createHarness("api_alerts");
    h.clock.now = Date.parse("2026-04-01T03:00:00Z");
    tenant = await h.createTenant("A");
    tokyo = await h.createSite(tenant, "東京");
    osaka = await h.createSite(tenant, "大阪");
    ids.admin = await h.createUser(tenant, "admin@example.com", "tenant_admin");
    ids.tokyo = await h.createUser(tenant, "tokyo@example.com", "site_admin", [tokyo]);
    ids.osaka = await h.createUser(tenant, "osaka@example.com", "site_admin", [osaka]);
    admin = await h.callerAs(tenant, ids.admin);
    tokyoAdmin = await h.callerAs(tenant, ids.tokyo);
    osakaAdmin = await h.callerAs(tenant, ids.osaka);
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [tokyo]));
  });
  afterAll(async () => h?.end());

  it("署名検証に失敗したカードを登録すると、要確認アラートと通知(担当者のみ・氏名なし)ができる", async () => {
    const { id: personId } = await tokyoAdmin.persons.create({ siteId: tokyo, employeeCode: "NR1", name: "偽造 太郎" });
    const files = buildCardFiles({ format: "gen2", kind: "residence", cardNumber: "AB12345678CD", signer: ec });
    files["df1/ef02"]![5]! ^= 1;
    const b64: Partial<Record<EfPath, string>> = {};
    for (const [k, v] of Object.entries(files)) if (v) b64[k as EfPath] = toBase64(v);
    const r = await tokyoAdmin.cards.register({ personId, cardNumber: "AB12345678CD", ic: { format: "gen2", kind: "residence", files: b64 } });
    expect(r.needsReview).toBe(true);

    const list = await tokyoAdmin.alerts.list();
    expect(list).toEqual([expect.objectContaining({ type: "needs_review", dueDate: "2026-04-01", person: expect.objectContaining({ id: personId }) })]);
    const outbox = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox));
    expect([...new Set(outbox.map((o) => o.userId))].sort()).toEqual([ids.admin, ids.tokyo].sort());
    expect(JSON.stringify(outbox.map((o) => o.payload))).not.toContain("偽造 太郎");
  });

  it("拠点の範囲: 担当外の拠点管理者には見えず、対応もできない。閲覧者は使えない", async () => {
    expect(await osakaAdmin.alerts.list()).toEqual([]);
    const [a] = await admin.alerts.list();
    expect(await codeOf(osakaAdmin.alerts.acknowledge({ id: a!.id }))).toBe("NOT_FOUND");
    expect(await codeOf(viewer.alerts.list())).toBe("FORBIDDEN");
  });

  it("対応済みにすると未対応の一覧から消え、監査ログに残る", async () => {
    const [a] = await tokyoAdmin.alerts.list();
    await tokyoAdmin.alerts.acknowledge({ id: a!.id });
    expect(await tokyoAdmin.alerts.list()).toEqual([]);
    expect((await tokyoAdmin.alerts.list({ open: false, limit: 50, offset: 0 }))[0]!.acknowledgedAt).not.toBeNull();
    expect(await codeOf(tokyoAdmin.alerts.acknowledge({ id: a!.id }))).toBe("BAD_REQUEST");
    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, a!.id)));
    expect(logs.map((l) => l.action)).toEqual(["alert.acknowledge"]);
  });

  it("端末のプッシュ通知トークンを登録できる(形式は検証する)", async () => {
    await viewer.devices.registerPushToken({ token: "ExponentPushToken[abcdefghijklmnop]", platform: "android" });
    expect(await codeOf(viewer.devices.registerPushToken({ token: "https://evil.example.com", platform: "android" }))).toBe("BAD_REQUEST");
    const d = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.userDevices));
    expect(d).toHaveLength(1);
  });
});
