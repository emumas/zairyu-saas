/** 日次人数記録と月次確定(1-16)。TEST_DATABASE_URL が無ければスキップ */
import { createDb, listDailyCounts, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordDailyBilling } from "./billing.js";

const url = process.env.TEST_DATABASE_URL;
const at = (jstDateTime: string) => Date.parse(`${jstDateTime}+09:00`);

describe.skipIf(!url)("日次人数記録と月次確定", () => {
  let db: Db;
  let end: () => Promise<void>;
  let tenant: string;
  let noPlan: string;
  let planId: string;

  const periods = (t: string) => withTenant(db, t, (tx) => tx.select().from(schema.billingPeriods).orderBy(schema.billingPeriods.period));
  const addPerson = (t: string, code: string, createdAt: string, extra: Partial<typeof schema.persons.$inferInsert> = {}) =>
    withTenant(db, t, async (tx) => {
      const [site] = await tx.select().from(schema.sites);
      await tx.insert(schema.persons).values({ siteId: site!.id, employeeCode: code, name: `氏名${code}`, createdAt: new Date(at(createdAt)), ...extra });
    });

  beforeAll(async () => {
    const c = createDb(await prepareTestDatabase(url!, "worker_billing"), { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    await withPlatform(db, async (tx) => {
      const [plan] = await tx.insert(schema.plans).values({ name: "標準", baseFee: 1000, billingMode: "per_unit", unitPrice: 300 }).returning();
      planId = plan!.id;
      tenant = (await tx.insert(schema.tenants).values({ name: "A", status: "active", planId }).returning())[0]!.id;
      noPlan = (await tx.insert(schema.tenants).values({ name: "B", status: "trial" }).returning())[0]!.id;
    });
    for (const t of [tenant, noPlan]) await withTenant(db, t, (tx) => tx.insert(schema.sites).values({ name: "本社" }));

    await addPerson(tenant, "P1", "2026-03-01T09:00:00");
    await addPerson(tenant, "P2", "2026-03-01T09:00:00", { status: "retired", retiredAt: "2026-03-10" }); // 3/10 まで数える
    await addPerson(tenant, "P3", "2026-03-10T23:59:00", { status: "archived", retiredAt: "2026-03-15", archivedAt: new Date(at("2026-03-20T10:00:00")) });
    await addPerson(tenant, "P4", "2026-03-11T00:00:01"); // 3/11 から数える
    await addPerson(noPlan, "X1", "2026-03-01T09:00:00");
  });
  afterAll(async () => end?.());

  it("前日の人数を数える(退職日・アーカイブ時の退職日までは数え、翌日から外す。登録日の終わりまでに登録された人を数える)", async () => {
    expect(await recordDailyBilling(db, tenant, at("2026-03-11T00:30:00"))).toEqual({
      date: "2026-03-10",
      activeCount: 3,
      period: "2026-03",
      peakCount: 3,
      amount: 1000 + 3 * 300,
      finalized: false,
    });
    expect((await recordDailyBilling(db, tenant, at("2026-03-12T00:30:00"))).activeCount).toBe(3); // P1・P3・P4
    expect((await recordDailyBilling(db, tenant, at("2026-03-16T00:30:00"))).activeCount).toBe(3); // 3/15 は P3 まで
    expect((await recordDailyBilling(db, tenant, at("2026-03-17T00:30:00"))).activeCount).toBe(2);
    expect(await periods(tenant)).toMatchObject([{ period: "2026-03", peakCount: 3, amount: 1900, status: "open" }]);
  });

  it("同じ日を再実行したら上書きする", async () => {
    await addPerson(tenant, "P5", "2026-03-01T09:00:00");
    await recordDailyBilling(db, tenant, at("2026-03-17T05:00:00"));
    const days = await withTenant(db, tenant, (tx) => listDailyCounts(tx, "2026-03"));
    expect(days.map((d) => [d.date, d.activeCount])).toEqual([
      ["2026-03-10", 3],
      ["2026-03-11", 3],
      ["2026-03-15", 3],
      ["2026-03-16", 3], // 再実行で P5 が加わった(2 → 3)
    ]);
  });

  it("月末の分を記録したら、その月の最大人数で確定する。確定後に翌月が始まる", async () => {
    const r = await recordDailyBilling(db, tenant, at("2026-04-01T00:30:00"));
    expect(r).toMatchObject({ date: "2026-03-31", activeCount: 3, peakCount: 3, amount: 1000 + 3 * 300, finalized: true });
    await recordDailyBilling(db, tenant, at("2026-04-02T00:30:00"));
    expect((await periods(tenant)).map((p) => [p.period, p.peakCount, p.amount, p.status])).toEqual([
      ["2026-03", 3, 1900, "finalized"],
      ["2026-04", 3, 1900, "open"],
    ]);
  });

  it("Stripe に送った後の月は、再実行しても変えない", async () => {
    await withPlatform(db, (tx) => tx.update(schema.billingPeriods).set({ status: "reported" }).where(eq(schema.billingPeriods.period, "2026-03")));
    await withPlatform(db, (tx) => tx.update(schema.plans).set({ unitPrice: 999 }).where(eq(schema.plans.id, planId)));
    await recordDailyBilling(db, tenant, at("2026-04-01T06:00:00"));
    expect((await periods(tenant))[0]).toMatchObject({ period: "2026-03", amount: 1900, status: "reported" });
    await withPlatform(db, (tx) => tx.update(schema.plans).set({ unitPrice: 300 }).where(eq(schema.plans.id, planId)));
  });

  it("個別単価があればそちらで計算する", async () => {
    await withPlatform(db, (tx) => tx.insert(schema.tenantPriceOverrides).values({ tenantId: tenant, unitPrice: 100 }));
    expect((await recordDailyBilling(db, tenant, at("2026-04-03T00:30:00"))).amount).toBe(1000 + 3 * 100);
  });

  it("ジョブが月末に動かなかった月も、翌月の記録で確定にする", async () => {
    await recordDailyBilling(db, noPlan, at("2026-05-10T00:30:00"));
    expect((await periods(noPlan)).at(-1)).toMatchObject({ period: "2026-05", status: "open" });
    const r = await recordDailyBilling(db, noPlan, at("2026-06-05T00:30:00"));
    expect(r.amount).toBeNull(); // プラン未設定(トライアル)は金額なし
    expect((await periods(noPlan)).map((p) => [p.period, p.peakCount, p.amount, p.status])).toEqual([
      ["2026-05", 1, 0, "finalized"],
      ["2026-06", 1, 0, "open"],
    ]);
  });

  it("他のテナントの人数は数えない", async () => {
    expect((await recordDailyBilling(db, noPlan, at("2026-06-06T00:30:00"))).activeCount).toBe(1);
  });
});
