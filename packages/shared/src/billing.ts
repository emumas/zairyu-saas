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

// ---------------------------------------------------------------- 未払い時の制御(1-18)

/** 支払い失敗から通常どおり使える日数(DESIGN.md 6章の案) */
export const PAST_DUE_GRACE_DAYS = 14;

export type BillingRestriction =
  /** 通常 */
  | { state: "ok" }
  /** 未払いだが猶予期間中(通常どおり使える。画面でお知らせする) */
  | { state: "grace"; graceEndsAt: string | null }
  /** 猶予期間を過ぎた: 新しい登録者の追加(登録・CSV の新規・復職)だけを止める。閲覧・期限アラート・カードの更新は止めない */
  | { state: "restricted"; since: string };

/**
 * 契約状態から、新規登録を止めるかを決める。
 * 未払いの起点が無い(手動で未払いにした古いデータなど)ときは猶予中として扱い、黙って止めない
 */
export function billingRestriction(status: string, pastDueSince: Date | null, nowMs: number): BillingRestriction {
  if (status !== "past_due") return { state: "ok" };
  if (!pastDueSince) return { state: "grace", graceEndsAt: null };
  const ends = pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000;
  return nowMs < ends ? { state: "grace", graceEndsAt: new Date(ends).toISOString() } : { state: "restricted", since: new Date(ends).toISOString() };
}

/** 新規登録を止めたときのメッセージ(アプリにも出すので、料金・購入の案内は入れない) */
export const RESTRICTED_MESSAGE = "ご契約の確認が必要なため、新しい登録者を追加できません。テナント管理者にお問い合わせください(閲覧と期限アラートは引き続き使えます)";
