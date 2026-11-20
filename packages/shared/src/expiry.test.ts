import { describe, expect, it } from "vitest";
import { addMonths, alertDueDates, classifyExpiry, type CardForExpiry } from "./expiry.js";

const card = (c: Partial<CardForExpiry>): CardForExpiry => ({
  expiryDate: null,
  cardValidUntil: null,
  pendingApplication: false,
  icVerified: true,
  needsReview: false,
  ...c,
});
const TODAY = "2026-04-01";

describe("期限区分", () => {
  it.each([
    ["2026-03-31", "expired", -1],
    ["2026-04-01", "within30", 0], // 満了日当日はまだ有効
    ["2026-05-01", "within30", 30],
    ["2026-05-02", "within90", 31],
    ["2026-06-30", "within90", 90],
    ["2026-07-01", "ok", 91],
  ] as const)("満了日 %s → %s(残り %i 日)", (expiryDate, bucket, days) => {
    expect(classifyExpiry(card({ expiryDate }), TODAY)).toMatchObject({ bucket, daysLeft: days, deadlineBasis: "stay" });
  });

  it("カード未登録", () => {
    expect(classifyExpiry(null, TODAY).bucket).toBe("noCard");
  });

  it("永住者など在留期限が無ければカードの有効期限で判定する", () => {
    expect(classifyExpiry(card({ cardValidUntil: "2026-04-20" }), TODAY)).toMatchObject({ bucket: "within30", deadlineBasis: "card" });
    expect(classifyExpiry(card({}), TODAY).bucket).toBe("noExpiry");
  });

  describe("更新申請中(特例期間)", () => {
    it("満了日前でも申請中なら更新申請中", () => {
      expect(classifyExpiry(card({ expiryDate: "2026-04-10", pendingApplication: true }), TODAY)).toMatchObject({
        bucket: "pending",
        specialPeriodUntil: "2026-06-10",
      });
    });

    it("満了日を過ぎても 2 か月以内なら更新申請中", () => {
      expect(classifyExpiry(card({ expiryDate: "2026-02-01", pendingApplication: true }), TODAY).bucket).toBe("pending");
      expect(classifyExpiry(card({ expiryDate: "2026-02-01", pendingApplication: true }), "2026-04-01").specialPeriodUntil).toBe("2026-04-01");
    });

    it("特例期間を過ぎたら期限切れ", () => {
      expect(classifyExpiry(card({ expiryDate: "2026-01-31", pendingApplication: true }), TODAY)).toMatchObject({
        bucket: "expired",
        specialPeriodUntil: "2026-03-31",
      });
    });
  });

  it("IC 未検証・要確認は区分と別の目印", () => {
    const s = classifyExpiry(card({ expiryDate: "2030-01-01", icVerified: false, needsReview: true }), TODAY);
    expect(s).toMatchObject({ bucket: "ok", icUnverified: true, needsReview: true });
  });

  it("2 か月後の応当日(月末は丸める)", () => {
    expect(addMonths("2026-03-31", 2)).toBe("2026-05-31");
    expect(addMonths("2026-12-31", 2)).toBe("2027-02-28");
    expect(addMonths("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });

  it("アラートの通知日", () => {
    expect(alertDueDates("2026-07-01").map((a) => a.dueDate)).toEqual(["2026-04-02", "2026-05-02", "2026-06-01", "2026-07-01"]);
  });
});
