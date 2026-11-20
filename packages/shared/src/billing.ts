/**
 * 料金計算(1-16)。金額はすべて整数(円・税抜)。
 * 課金対象人数は「月内の有効登録者数の日次最大値」(DESIGN.md 6章)。
 *
 * 料金モデル
 * - per_unit(基本料+単価): 基本料 + 人数 × 単価
 * - tiered(段階制): 基本料 + 人数帯ごとの単価で積み上げ(例: 〜100 人は 300 円、101〜500 人は 250 円…)。
 *   人数帯をまたいでも総額が下がらないよう、全員に同じ単価を掛ける方式(ボリューム)ではなく積み上げ(グラデュエーテッド)にする。
 *   Stripe の tiers_mode=graduated と同じ計算
 * - 個別単価: テナント単位で基本料・単価・人数帯を上書きする(上書きしない項目はプランの値)
 */
import { z } from "zod";

const yen = z.number().int().min(0).max(100_000_000);

export const pricingTierSchema = z.object({
  /** この帯の上限人数(この人数を含む)。最後の帯は null(上限なし) */
  upTo: z.number().int().min(1).nullable(),
  unitPrice: yen,
});
export type PricingTier = z.infer<typeof pricingTierSchema>;

export const pricingTiersSchema = z
  .array(pricingTierSchema)
  .min(1)
  .max(20)
  .superRefine((tiers, ctx) => {
    tiers.forEach((t, i) => {
      const last = i === tiers.length - 1;
      if (last && t.upTo !== null) ctx.addIssue({ code: "custom", message: "最後の人数帯は上限なしにしてください" });
      if (!last && t.upTo === null) ctx.addIssue({ code: "custom", message: "上限なしは最後の人数帯だけにしてください" });
      const prev = tiers[i - 1];
      if (prev?.upTo != null && t.upTo !== null && t.upTo <= prev.upTo) ctx.addIssue({ code: "custom", message: "人数帯の上限は小さい順に並べてください" });
    });
  });

export type Pricing = { baseFee: number } & ({ mode: "per_unit"; unitPrice: number } | { mode: "tiered"; tiers: PricingTier[] });

export interface PlanPricingSource {
  baseFee: number;
  billingMode: "per_unit" | "tiered";
  unitPrice: number | null;
  tiersJson: unknown;
}

export interface PriceOverrideSource {
  planId: string | null;
  baseFee: number | null;
  unitPrice: number | null;
  tiersJson: unknown;
}

/**
 * プランと個別単価から、そのテナントの料金を決める。
 * 個別単価はプランを指定していなければどのプランにも、指定していればそのプランのときだけ効く。
 * 個別単価で人数帯を指定すれば段階制、単価を指定すれば基本料+単価になる。設定が壊れていれば例外
 */
export function resolvePricing(plan: PlanPricingSource & { id: string }, override?: PriceOverrideSource | null): Pricing {
  const o = override && (override.planId === null || override.planId === plan.id) ? override : null;
  const baseFee = yen.parse(o?.baseFee ?? plan.baseFee);
  if (o?.tiersJson != null) return { baseFee, mode: "tiered", tiers: pricingTiersSchema.parse(o.tiersJson) };
  if (o?.unitPrice != null) return { baseFee, mode: "per_unit", unitPrice: yen.parse(o.unitPrice) };
  if (plan.billingMode === "tiered") return { baseFee, mode: "tiered", tiers: pricingTiersSchema.parse(plan.tiersJson) };
  return { baseFee, mode: "per_unit", unitPrice: yen.parse(plan.unitPrice) };
}

export interface ChargeLine {
  /** 例: 基本料 / 1〜100 人 / 101 人〜 */
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/** 月額の内訳と合計(円・税抜) */
export function calculateCharge(pricing: Pricing, peakCount: number): { lines: ChargeLine[]; total: number } {
  if (!Number.isInteger(peakCount) || peakCount < 0) throw new RangeError("人数は 0 以上の整数");
  const lines: ChargeLine[] = [];
  if (pricing.baseFee > 0) lines.push({ label: "基本料", quantity: 1, unitPrice: pricing.baseFee, amount: pricing.baseFee });
  if (pricing.mode === "per_unit") {
    lines.push({ label: "登録者", quantity: peakCount, unitPrice: pricing.unitPrice, amount: peakCount * pricing.unitPrice });
  } else {
    let from = 1;
    for (const t of pricing.tiers) {
      if (from > peakCount) break;
      const to = t.upTo === null ? peakCount : Math.min(t.upTo, peakCount);
      const quantity = to - from + 1;
      lines.push({ label: t.upTo === null ? `${from} 人〜` : `${from}〜${t.upTo} 人`, quantity, unitPrice: t.unitPrice, amount: quantity * t.unitPrice });
      from = to + 1;
    }
  }
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("金額が大きすぎます");
  return { lines, total };
}

/** YYYY-MM-DD の月(YYYY-MM) */
export const periodOf = (date: string) => date.slice(0, 7);

/** その月の最終日か */
export function isLastDayOfMonth(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate() === 1;
}

// ---------------------------------------------------------------- 運営者コンソール(1-19)

/** プランの入力。基本料+単価なら unitPrice、段階制なら tiers が必須 */
export const planInput = z
  .object({
    name: z.string().trim().min(1, "プラン名を入力してください").max(100),
    baseFee: yen,
    billingMode: z.enum(["per_unit", "tiered"]),
    unitPrice: yen.nullable(),
    tiers: pricingTiersSchema.nullable(),
  })
  .refine((p) => (p.billingMode === "per_unit" ? p.unitPrice !== null : p.tiers !== null), {
    message: "基本料+単価は単価を、段階制は人数帯を入力してください",
  });
export type PlanInput = z.infer<typeof planInput>;

/** 個別単価の入力。null の項目はプランの値を使う。単価と人数帯の両方は指定できない */
export const priceOverrideInput = z
  .object({
    /** 指定すると、そのプランのときだけ効く */
    planId: z.uuid().nullable(),
    baseFee: yen.nullable(),
    unitPrice: yen.nullable(),
    tiers: pricingTiersSchema.nullable(),
  })
  .refine((o) => !(o.unitPrice !== null && o.tiers !== null), { message: "単価と人数帯はどちらか一方にしてください" })
  .refine((o) => o.baseFee !== null || o.unitPrice !== null || o.tiers !== null, { message: "上書きする項目を 1 つ以上入力してください" });
export type PriceOverrideInput = z.infer<typeof priceOverrideInput>;

export const TENANT_STATUSES = ["trial", "active", "past_due", "suspended"] as const;
export const TENANT_STATUS_LABEL: Record<(typeof TENANT_STATUSES)[number], string> = {
  trial: "トライアル",
  active: "契約中",
  past_due: "未払い",
  suspended: "停止",
};
