import { describe, expect, it } from "vitest";
import { expiryAlertFor, expiryDigest } from "./alerts.js";
import type { CardForExpiry } from "./expiry.js";

const card = (expiryDate: string | null, c: Partial<CardForExpiry> = {}): CardForExpiry => ({
  expiryDate,
  cardValidUntil: null,
  pendingApplication: false,
  icVerified: true,
  needsReview: false,
  ...c,
});

describe("期限アラートの判定", () => {
  it.each([
    ["2026-07-01", "2026-04-01", null], // 91 日前: まだ
    ["2026-06-30", "2026-04-01", "expiry_90"], // ちょうど 90 日前
    ["2026-05-31", "2026-04-01", "expiry_60"],
    ["2026-05-01", "2026-04-01", "expiry_30"],
    ["2026-04-01", "2026-04-01", "expired"], // 当日
    ["2026-03-01", "2026-04-01", "expired"], // 期限切れ
  ] as const)("満了日 %s・今日 %s → %s", (expiry, today, type) => {
    expect(expiryAlertFor(card(expiry), today)?.type ?? null).toBe(type);
  });

  it("期限間近で登録しても、いちばん新しい段階だけを出す", () => {
    expect(expiryAlertFor(card("2026-04-20"), "2026-04-01")).toEqual({ type: "expiry_30", dueDate: "2026-03-21" });
  });

  it("更新申請中・期限なし・カード未登録は出さない", () => {
    expect(expiryAlertFor(card("2026-04-10", { pendingApplication: true }), "2026-04-01")).toBeNull();
    expect(expiryAlertFor(card(null), "2026-04-01")).toBeNull();
    expect(expiryAlertFor(null, "2026-04-01")).toBeNull();
  });

  it("特例期間を過ぎたら期限切れのアラート", () => {
    expect(expiryAlertFor(card("2026-01-31", { pendingApplication: true }), "2026-04-01")?.type).toBe("expired");
  });

  it("永住者はカードの有効期限で判定する", () => {
    expect(expiryAlertFor(card(null, { cardValidUntil: "2026-05-01" }), "2026-04-01")?.type).toBe("expiry_30");
  });
});

describe("まとめ通知", () => {
  it("件数だけを載せる", () => {
    const p = expiryDigest({ expiry_30: 2, expired: 1 });
    expect(p?.body).toBe("期限当日・期限切れ 1名、30日以内 2名。アプリで対象者を確認してください。");
  });
  it("対象がなければ通知しない", () => {
    expect(expiryDigest({})).toBeNull();
  });
});
