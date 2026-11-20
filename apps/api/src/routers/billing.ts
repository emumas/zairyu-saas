/**
 * 契約・請求の表示(1-16)。テナント管理者のみ(billing.manage)。
 * 課金対象人数の根拠として日別人数を公開する(DESIGN.md 6章)。契約・決済の操作は 1-17(Stripe)
 */
import { countBillablePersons, listBillingPeriods, listDailyCounts, peakCountOf, tenantPricingSources } from "@zairyu/db";
import { calculateCharge, jstDate, periodOf, resolvePricing, type Pricing } from "@zairyu/shared";
import { z } from "zod";
import { permissionProcedure, router } from "../trpc.js";

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const pricingOutput = z.union([
  z.object({ baseFee: z.number(), mode: z.literal("per_unit"), unitPrice: z.number() }),
  z.object({ baseFee: z.number(), mode: z.literal("tiered"), tiers: z.array(z.object({ upTo: z.number().nullable(), unitPrice: z.number() })) }),
]);

export const billingRouter = router({
  summary: permissionProcedure("billing.manage")
    .input(z.object({ period: period.optional() }))
    .output(
      z.object({
        tenantStatus: z.enum(["trial", "active", "past_due", "suspended"]),
        planName: z.string().nullable(),
        pricing: pricingOutput.nullable(),
        /** 料金設定に誤りがあり計算できない(運営者に連絡) */
        pricingError: z.boolean(),
        today: z.string(),
        /** 今の課金対象人数(今日の記録は翌日 0 時過ぎ) */
        currentCount: z.number(),
        period: z.string(),
        peakCount: z.number(),
        charge: z.object({ lines: z.array(z.object({ label: z.string(), quantity: z.number(), unitPrice: z.number(), amount: z.number() })), total: z.number() }).nullable(),
        daily: z.array(z.object({ date: z.string(), activeCount: z.number() })),
        periods: z.array(z.object({ period: z.string(), peakCount: z.number(), amount: z.number(), status: z.string() })),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const target = input.period ?? periodOf(today);
        const src = await tenantPricingSources(tx);
        let pricing: Pricing | null = null;
        let pricingError = false;
        if (src?.plan) {
          try {
            pricing = resolvePricing(src.plan, src.override);
          } catch {
            pricingError = true;
          }
        }
        const periods = await listBillingPeriods(tx);
        const recorded = periods.find((p) => p.period === target);
        const currentCount = await countBillablePersons(tx, today);
        // 当月は記録済みの最大値と今の人数の大きい方を見込みとして出す。過去の月は記録した値
        const peakCount = target === periodOf(today) ? Math.max(await peakCountOf(tx, target), currentCount) : (recorded?.peakCount ?? (await peakCountOf(tx, target)));
        // 内訳は当月の見込みだけ(過去の月は確定時の金額を periods で返す。料金がその後変わっていても変えない)
        const charge = pricing && target === periodOf(today) ? calculateCharge(pricing, peakCount) : null;
        return {
          tenantStatus: src?.tenant.status ?? "trial",
          planName: src?.plan?.name ?? null,
          pricing,
          pricingError,
          today,
          currentCount,
          period: target,
          peakCount,
          charge,
          daily: await listDailyCounts(tx, target),
          periods,
        };
      }),
    ),
});
