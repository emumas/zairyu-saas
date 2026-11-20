/**
 * 日次人数記録と月次確定(1-16)。毎日深夜(JST)に、前日分を記録する。
 * - 前日の課金対象人数を daily_counts に記録(再実行したら上書き)
 * - その月の最大値と見込み額を billing_periods に記録(集計中 = open)。前日が月末なら確定(finalized)
 * - ジョブが止まっていた月の集計中の請求も確定にする
 * Stripe への送信(確定 → reported)は 1-17
 */
import {
  countBillablePersons,
  finalizeOpenPeriodsBefore,
  peakCountOf,
  tenantPricingSources,
  upsertBillingPeriod,
  upsertDailyCount,
  withTenant,
  type Db,
} from "@zairyu/db";
import { addDays, calculateCharge, isLastDayOfMonth, jstDate, periodOf, resolvePricing } from "@zairyu/shared";

export interface DailyBillingResult {
  date: string;
  activeCount: number;
  period: string;
  peakCount: number;
  /** プラン未設定なら null */
  amount: number | null;
  finalized: boolean;
}

export async function recordDailyBilling(db: Db, tenantId: string, nowMs: number): Promise<DailyBillingResult> {
  const date = addDays(jstDate(nowMs), -1);
  const period = periodOf(date);
  // 人数の記録は料金設定の誤りに巻き込まれないよう、別のトランザクションで先に確定させる
  const activeCount = await withTenant(db, tenantId, async (tx) => {
    const n = await countBillablePersons(tx, date);
    await upsertDailyCount(tx, date, n);
    return n;
  });
  return withTenant(db, tenantId, async (tx) => {
    const peakCount = await peakCountOf(tx, period);
    const src = await tenantPricingSources(tx);
    const amount = src?.plan ? calculateCharge(resolvePricing(src.plan, src.override), peakCount).total : null;
    const finalized = isLastDayOfMonth(date);
    await finalizeOpenPeriodsBefore(tx, period);
    await upsertBillingPeriod(tx, { period, peakCount, amount: amount ?? 0, status: finalized ? "finalized" : "open" });
    return { date, activeCount, period, peakCount, amount, finalized };
  });
}
