/** 契約・請求の表示(1-16)。TEST_DATABASE_URL が無ければスキップ */
import { schema, withPlatform, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("契約・請求の表示", () => {
  let h: Harness;
  let tenant: string;
  let admin: AppCaller;
  let siteAdmin: AppCaller;
  let today: string;

  beforeAll(async () => {
    h = await createHarness("api_billing");
    tenant = await h.createTenant("A");
    const site = await h.createSite(tenant, "本社");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    siteAdmin = await h.callerAs(tenant, await h.createUser(tenant, "site@example.com", "site_admin", [site]));
    today = new Date(h.clock.now + 9 * 3600_000).toISOString().slice(0, 10);
    for (const code of ["A", "B"]) await admin.persons.create({ siteId: site, employeeCode: code, name: code });
  });
  afterAll(async () => h?.end());

  it("テナント管理者だけが見られる", async () => {
    expect(await codeOf(siteAdmin.billing.summary({}))).toBe("FORBIDDEN");
  });

  it("プラン未設定なら人数だけ。記録済みの最大値と今の人数の大きい方を当月の見込みにする", async () => {
    const s = await admin.billing.summary({});
    expect(s).toMatchObject({ planName: null, pricing: null, charge: null, currentCount: 2, peakCount: 2, period: today.slice(0, 7) });
    await withTenant(h.db, tenant, (tx) => tx.insert(schema.dailyCounts).values({ date: `${today.slice(0, 7)}-01`, activeCount: 5 }));
    const s2 = await admin.billing.summary({});
    expect(s2.peakCount).toBe(5);
    expect(s2.daily).toEqual([{ date: `${today.slice(0, 7)}-01`, activeCount: 5 }]);
  });

  it("プランがあれば当月の見込み額と内訳を返す。過去の月は確定時の金額", async () => {
    await withPlatform(h.db, async (tx) => {
      const [plan] = await tx.insert(schema.plans).values({ name: "標準", baseFee: 1000, billingMode: "per_unit", unitPrice: 300 }).returning();
      await tx.update(schema.tenants).set({ planId: plan!.id }).where(eq(schema.tenants.id, tenant));
    });
    await withTenant(h.db, tenant, (tx) => tx.insert(schema.billingPeriods).values({ period: "2020-01", peakCount: 9, amount: 12_345, status: "paid" }));
    const s = await admin.billing.summary({});
    expect(s.planName).toBe("標準");
    expect(s.charge?.total).toBe(1000 + 5 * 300);
    const past = await admin.billing.summary({ period: "2020-01" });
    expect(past).toMatchObject({ peakCount: 9, charge: null });
    expect(past.periods.find((p) => p.period === "2020-01")).toMatchObject({ amount: 12_345, status: "paid" });
  });

  it("料金設定が壊れていても画面は出す", async () => {
    await withPlatform(h.db, (tx) => tx.update(schema.plans).set({ billingMode: "tiered", tiersJson: [{ upTo: 10, unitPrice: 1 }] }).where(eq(schema.plans.name, "標準")));
    expect(await admin.billing.summary({})).toMatchObject({ pricing: null, pricingError: true, charge: null });
  });
});
