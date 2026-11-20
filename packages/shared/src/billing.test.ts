import { describe, expect, it } from "vitest";
import { calculateCharge, isLastDayOfMonth, periodOf, pricingTiersSchema, resolvePricing, type Pricing } from "./billing.js";

const tiered: Pricing = {
  baseFee: 10_000,
  mode: "tiered",
  tiers: [
    { upTo: 100, unitPrice: 300 },
    { upTo: 500, unitPrice: 250 },
    { upTo: 1000, unitPrice: 200 },
    { upTo: null, unitPrice: 150 },
  ],
};

describe("calculateCharge", () => {
  it("基本料+単価", () => {
    expect(calculateCharge({ baseFee: 5000, mode: "per_unit", unitPrice: 300 }, 42)).toEqual({
      lines: [
        { label: "基本料", quantity: 1, unitPrice: 5000, amount: 5000 },
        { label: "登録者", quantity: 42, unitPrice: 300, amount: 12_600 },
      ],
      total: 17_600,
    });
  });

  it("0 人なら基本料だけ。基本料 0 円の行は出さない", () => {
    expect(calculateCharge({ baseFee: 5000, mode: "per_unit", unitPrice: 300 }, 0).total).toBe(5000);
    expect(calculateCharge({ baseFee: 0, mode: "per_unit", unitPrice: 300 }, 3).lines).toEqual([{ label: "登録者", quantity: 3, unitPrice: 300, amount: 900 }]);
    expect(calculateCharge(tiered, 0)).toEqual({ lines: [{ label: "基本料", quantity: 1, unitPrice: 10_000, amount: 10_000 }], total: 10_000 });
  });

  it.each([
    [1, 10_000 + 300],
    [100, 10_000 + 30_000],
    [101, 10_000 + 30_000 + 250],
    [500, 10_000 + 30_000 + 100_000],
    [1000, 10_000 + 30_000 + 100_000 + 100_000],
    [1234, 10_000 + 30_000 + 100_000 + 100_000 + 234 * 150],
  ])("段階制は人数帯ごとに積み上げる(%i 人 → %i 円)", (n, total) => {
    expect(calculateCharge(tiered, n).total).toBe(total);
  });

  it("段階制の内訳", () => {
    expect(calculateCharge(tiered, 120).lines.map((l) => [l.label, l.quantity, l.amount])).toEqual([
      ["基本料", 1, 10_000],
      ["1〜100 人", 100, 30_000],
      ["101〜500 人", 20, 5_000],
    ]);
    expect(calculateCharge(tiered, 1001).lines.at(-1)).toEqual({ label: "1001 人〜", quantity: 1, unitPrice: 150, amount: 150 });
  });

  it("人数が増えて総額が下がることはない", () => {
    let prev = -1;
    for (let n = 0; n <= 1500; n++) {
      const t = calculateCharge(tiered, n).total;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("人数は 0 以上の整数", () => {
    expect(() => calculateCharge(tiered, -1)).toThrow(RangeError);
    expect(() => calculateCharge(tiered, 1.5)).toThrow(RangeError);
  });
});

describe("pricingTiersSchema", () => {
  it("小さい順・最後だけ上限なし", () => {
    expect(pricingTiersSchema.safeParse(tiered.mode === "tiered" ? tiered.tiers : []).success).toBe(true);
    expect(pricingTiersSchema.safeParse([{ upTo: 100, unitPrice: 300 }]).success).toBe(false);
    expect(pricingTiersSchema.safeParse([{ upTo: null, unitPrice: 300 }, { upTo: null, unitPrice: 200 }]).success).toBe(false);
    expect(pricingTiersSchema.safeParse([{ upTo: 500, unitPrice: 300 }, { upTo: 100, unitPrice: 200 }, { upTo: null, unitPrice: 100 }]).success).toBe(false);
    expect(pricingTiersSchema.safeParse([{ upTo: 100, unitPrice: 1.5 }, { upTo: null, unitPrice: 100 }]).success).toBe(false);
  });
});

describe("resolvePricing", () => {
  const plan = { id: "p1", baseFee: 10_000, billingMode: "per_unit" as const, unitPrice: 300, tiersJson: null };
  const tieredPlan = { id: "p2", baseFee: 0, billingMode: "tiered" as const, unitPrice: null, tiersJson: [{ upTo: 10, unitPrice: 100 }, { upTo: null, unitPrice: 50 }] };

  it("個別単価が無ければプランのまま", () => {
    expect(resolvePricing(plan)).toEqual({ baseFee: 10_000, mode: "per_unit", unitPrice: 300 });
    expect(resolvePricing(tieredPlan)).toEqual({ baseFee: 0, mode: "tiered", tiers: tieredPlan.tiersJson });
  });

  it("個別単価は指定した項目だけ上書きする", () => {
    expect(resolvePricing(plan, { planId: null, baseFee: null, unitPrice: 250, tiersJson: null })).toEqual({ baseFee: 10_000, mode: "per_unit", unitPrice: 250 });
    expect(resolvePricing(plan, { planId: null, baseFee: 0, unitPrice: null, tiersJson: null })).toEqual({ baseFee: 0, mode: "per_unit", unitPrice: 300 });
    expect(resolvePricing(plan, { planId: null, baseFee: null, unitPrice: null, tiersJson: tieredPlan.tiersJson })).toMatchObject({ mode: "tiered" });
    expect(resolvePricing(tieredPlan, { planId: null, baseFee: null, unitPrice: 80, tiersJson: null })).toEqual({ baseFee: 0, mode: "per_unit", unitPrice: 80 });
  });

  it("別のプラン向けの個別単価は使わない", () => {
    expect(resolvePricing(plan, { planId: "other", baseFee: 0, unitPrice: 1, tiersJson: null })).toEqual({ baseFee: 10_000, mode: "per_unit", unitPrice: 300 });
    expect(resolvePricing(plan, { planId: "p1", baseFee: 0, unitPrice: 1, tiersJson: null })).toEqual({ baseFee: 0, mode: "per_unit", unitPrice: 1 });
  });

  it("設定が壊れていれば例外(黙って 0 円にしない)", () => {
    expect(() => resolvePricing({ ...plan, unitPrice: null })).toThrow();
    expect(() => resolvePricing({ ...tieredPlan, tiersJson: [{ upTo: 10, unitPrice: 100 }] })).toThrow();
    expect(() => resolvePricing(plan, { planId: null, baseFee: -1, unitPrice: null, tiersJson: null })).toThrow();
  });
});

describe("月の扱い", () => {
  it.each([
    ["2026-01-31", true],
    ["2026-02-28", true],
    ["2028-02-28", false],
    ["2028-02-29", true],
    ["2026-12-31", true],
    ["2026-12-30", false],
  ])("%s は月末: %s", (d, expected) => {
    expect(isLastDayOfMonth(d)).toBe(expected);
  });
  it("periodOf", () => expect(periodOf("2026-11-20")).toBe("2026-11"));
});
