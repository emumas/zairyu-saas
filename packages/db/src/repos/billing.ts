/**
 * 日次人数記録と月次確定(1-16)。withTenant のトランザクションで呼ぶこと。
 * 課金対象は「その日に在籍していた登録者」: その日の終わりまでに登録され、
 * 在籍中か、退職日(アーカイブ時も退職日を残す)がその日以降の人。退職・アーカイブした人は翌日から数えない
 */
import { and, desc, eq, gte, inArray, lt, max, or, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { billingPeriods, dailyCounts, persons, plans, tenantPriceOverrides, tenants } from "../schema.js";

/** 月(YYYY-MM)の初日と翌月の初日 */
function monthRange(period: string): [string, string] {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${period}-01`, `${next}-01`];
}

/** date(JST の YYYY-MM-DD)の課金対象人数 */
export async function countBillablePersons(tx: Tx, date: string): Promise<number> {
  const endOfDay = sql`(${date}::date + 1)::timestamp at time zone 'Asia/Tokyo'`;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(persons)
    .where(and(lt(persons.createdAt, endOfDay), or(eq(persons.status, "active"), gte(persons.retiredAt, date))));
  return row?.n ?? 0;
}

/** 同じ日に再実行したら上書きする */
export async function upsertDailyCount(tx: Tx, date: string, activeCount: number): Promise<void> {
  await tx
    .insert(dailyCounts)
    .values({ date, activeCount })
    .onConflictDoUpdate({ target: [dailyCounts.tenantId, dailyCounts.date], set: { activeCount, recordedAt: new Date() } });
}

/** 月(YYYY-MM)の日別人数 */
export async function listDailyCounts(tx: Tx, period: string) {
  return tx
    .select({ date: dailyCounts.date, activeCount: dailyCounts.activeCount })
    .from(dailyCounts)
    .where(and(gte(dailyCounts.date, monthRange(period)[0]), lt(dailyCounts.date, monthRange(period)[1])))
    .orderBy(dailyCounts.date);
}

export async function peakCountOf(tx: Tx, period: string): Promise<number> {
  const [row] = await tx
    .select({ peak: max(dailyCounts.activeCount) })
    .from(dailyCounts)
    .where(and(gte(dailyCounts.date, monthRange(period)[0]), lt(dailyCounts.date, monthRange(period)[1])));
  return row?.peak ?? 0;
}

/** このテナントの契約状態・プラン・個別単価(料金計算の材料) */
export async function tenantPricingSources(tx: Tx) {
  const [t] = await tx.select({ id: tenants.id, status: tenants.status, planId: tenants.planId }).from(tenants);
  if (!t) return null;
  const [plan] = t.planId ? await tx.select().from(plans).where(eq(plans.id, t.planId)) : [];
  const [override] = await tx.select().from(tenantPriceOverrides);
  return { tenant: t, plan: plan ?? null, override: override ?? null };
}

/**
 * 月の請求を記録する。open(集計中)と finalized(確定。Stripe 送信前)のものだけ更新し、
 * Stripe に送った後(reported / paid / failed)は変えない
 */
export async function upsertBillingPeriod(
  tx: Tx,
  v: { period: string; peakCount: number; amount: number; status: "open" | "finalized" },
): Promise<boolean> {
  const rows = await tx
    .insert(billingPeriods)
    .values(v)
    .onConflictDoUpdate({
      target: [billingPeriods.tenantId, billingPeriods.period],
      set: { peakCount: v.peakCount, amount: v.amount, status: v.status },
      setWhere: inArray(billingPeriods.status, ["open", "finalized"]),
    })
    .returning({ id: billingPeriods.id });
  return rows.length > 0;
}

/** ジョブが月末に動かなかった場合に備え、前の月までの集計中の請求を確定にする */
export async function finalizeOpenPeriodsBefore(tx: Tx, period: string): Promise<number> {
  const rows = await tx
    .update(billingPeriods)
    .set({ status: "finalized" })
    .where(and(eq(billingPeriods.status, "open"), lt(billingPeriods.period, period)))
    .returning({ id: billingPeriods.id });
  return rows.length;
}

export async function listBillingPeriods(tx: Tx, limit = 24) {
  return tx
    .select({ period: billingPeriods.period, peakCount: billingPeriods.peakCount, amount: billingPeriods.amount, status: billingPeriods.status })
    .from(billingPeriods)
    .orderBy(desc(billingPeriods.period))
    .limit(limit);
}
