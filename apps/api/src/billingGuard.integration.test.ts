/** 未払い時の制御(1-18)。TEST_DATABASE_URL が無ければスキップ */
import { schema, withPlatform } from "@zairyu/db";
import { RESTRICTED_MESSAGE } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof TRPCError ? { code: e.code, message: e.message } : { code: String(e), message: "" }));
const DAY = 86_400_000;

describe.skipIf(!url)("未払い時の制御", () => {
  let h: Harness;
  let tenant: string;
  let site: string;
  let admin: AppCaller;
  let viewer: AppCaller;
  let retiredId: string;
  let activeId: string;
  const setStatus = (status: "active" | "past_due", pastDueSince: Date | null) =>
    withPlatform(h.db, (tx) => tx.update(schema.tenants).set({ status, pastDueSince }).where(eq(schema.tenants.id, tenant)));

  beforeAll(async () => {
    h = await createHarness("api_billing_guard");
    tenant = await h.createTenant("A");
    site = await h.createSite(tenant, "本社");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [site]));
    activeId = (await admin.persons.create({ siteId: site, employeeCode: "E1", name: "A" })).id;
    retiredId = (await admin.persons.create({ siteId: site, employeeCode: "E2", name: "B" })).id;
    await admin.persons.retire({ id: retiredId, reasonCode: "self" });
  });
  afterAll(async () => h?.end());

  it("未払いでも 14 日間は通常どおり使え、画面向けに猶予の期限を返す", async () => {
    await setStatus("past_due", new Date(h.clock.now - 13 * DAY));
    expect((await admin.me.get()).billing).toEqual({ state: "grace", graceEndsAt: new Date(h.clock.now + DAY).toISOString() });
    expect((await viewer.me.get()).billing.state).toBe("grace");
    await admin.persons.create({ siteId: site, employeeCode: "G1", name: "猶予中" });
  });

  it("猶予を過ぎたら、登録者の追加・復職・CSV の新規だけを止める", async () => {
    await setStatus("past_due", new Date(h.clock.now - 14 * DAY));
    expect((await admin.me.get()).billing.state).toBe("restricted");
    expect(await errOf(admin.persons.create({ siteId: site, employeeCode: "X1", name: "x" }))).toEqual({ code: "FORBIDDEN", message: RESTRICTED_MESSAGE });
    expect((await errOf(admin.persons.reactivate({ id: retiredId })))?.code).toBe("FORBIDDEN");

    const rows = [
      { line: 2, employeeCode: "E1", name: "A 更新", siteName: "本社", nationality: "", birthDate: "" },
      { line: 3, employeeCode: "N1", name: "新規", siteName: "本社", nationality: "", birthDate: "" },
    ];
    const preview = await admin.imports.previewPersons({ rows });
    expect(preview.rows.map((r) => [r.action, r.errors])).toEqual([
      ["update", []],
      ["error", [RESTRICTED_MESSAGE]],
    ]);
    expect(await admin.imports.commitPersons({ rows, skipErrors: true })).toMatchObject({ created: 0, updated: 1, skipped: 1 });
  });

  it("閲覧・更新・退職・ダッシュボードは止めない", async () => {
    expect((await admin.persons.list({})).total).toBeGreaterThan(0);
    await admin.persons.update({ id: activeId, name: "A 再更新" });
    await admin.persons.retire({ id: activeId, reasonCode: "self" });
    await admin.dashboard.summary({});
    await viewer.persons.list({});
  });

  it("契約中に戻すとすぐに元どおり", async () => {
    await setStatus("active", null);
    expect((await admin.me.get()).billing).toEqual({ state: "ok" });
    await admin.persons.reactivate({ id: retiredId });
    await admin.persons.create({ siteId: site, employeeCode: "X1", name: "x" });
  });
});
