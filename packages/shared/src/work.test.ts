import { describe, expect, it } from "vitest";
import { classifyExpiry } from "./expiry.js";
import { judgeWorkEligibility, outsidePermission, statusHint, type CardForWork } from "./work.js";

const today = "2026-04-01";
const base: CardForWork & { expiryDate: string | null; cardValidUntil: string | null; pendingApplication: boolean } = {
  cardKind: "residence",
  statusOfResidence: "技術・人文知識・国際業務",
  workRestriction: "2",
  outsideActivity: null,
  outsideActivityUntil: null,
  icVerified: true,
  needsReview: false,
  revocationResult: null,
  expiryDate: "2029-06-20",
  cardValidUntil: "2029-06-20",
  pendingApplication: false,
};
const judge = (c: Partial<typeof base> | null) => {
  const card = c === null ? null : { ...base, ...c };
  return judgeWorkEligibility(card, classifyExpiry(card, today), today);
};

describe("就労可否の判定", () => {
  it("就労制限なし・特別永住者は就労可", () => {
    expect(judge({ statusOfResidence: "永住者", workRestriction: "1", expiryDate: null })).toMatchObject({ level: "ok" });
    expect(judge({ cardKind: "special_permanent", workRestriction: null, statusOfResidence: null, expiryDate: null })).toMatchObject({ level: "ok" });
  });

  it("在留資格に基づく就労活動のみ可は条件付き。在留資格の範囲の目安を出す", () => {
    const r = judge({});
    expect(r.level).toBe("conditional");
    expect(r.checks.join()).toContain("単純作業");
  });

  it("指定書は条件付き。指定書の確認を求める", () => {
    const r = judge({ statusOfResidence: "特定技能1号", workRestriction: "4" });
    expect(r.level).toBe("conditional");
    expect(r.checks.join()).toContain("指定書");
    expect(r.checks.join()).toContain("特定産業分野");
  });

  it("就労不可: 資格外活動許可がなければ不可、包括許可なら週28時間の条件付き、個別許可は許可書の範囲", () => {
    expect(judge({ statusOfResidence: "留学", workRestriction: "9" })).toMatchObject({ level: "ng" });
    expect(judge({ statusOfResidence: "留学", workRestriction: "9", outsideActivity: "1" })).toMatchObject({ level: "conditional", weeklyHoursLimit: 28 });
    expect(judge({ statusOfResidence: "留学", workRestriction: "9", outsideActivity: "許可:原則週28時間以内・風俗営業等の従事を除く" })).toMatchObject({ level: "conditional", weeklyHoursLimit: 28 });
    const individual = judge({ statusOfResidence: "家族滞在", workRestriction: "9", outsideActivity: "許可:株式会社○○での通訳業務" });
    expect(individual).toMatchObject({ level: "conditional", weeklyHoursLimit: null });
    expect(individual.checks.join()).toContain("許可書");
    // 資格外活動許可の期限切れ
    expect(judge({ statusOfResidence: "留学", workRestriction: "9", outsideActivity: "1", outsideActivityUntil: "2026-03-31" })).toMatchObject({ level: "ng" });
  });

  it("在留期限切れ・失効は不可。更新申請中(特例期間)は判定を続けて確認事項を足す", () => {
    expect(judge({ workRestriction: "1", expiryDate: "2026-03-31" })).toMatchObject({ level: "ng" });
    expect(judge({ workRestriction: "1", revocationResult: "revoked" })).toMatchObject({ level: "ng" });
    const pending = judge({ workRestriction: "1", expiryDate: "2026-03-31", pendingApplication: true });
    expect(pending.level).toBe("ok");
    expect(pending.checks.join()).toContain("特例期間");
  });

  it("カード未登録・署名検証の失敗・就労制限の欄が未登録は要確認。IC 未検証は確認事項を足す", () => {
    expect(judge(null)).toMatchObject({ level: "check" });
    expect(judge({ needsReview: true, workRestriction: "1" })).toMatchObject({ level: "check" });
    expect(judge({ workRestriction: null })).toMatchObject({ level: "check" });
    const unverified = judge({ workRestriction: "1", icVerified: false });
    expect(unverified.level).toBe("ok");
    expect(unverified.checks.join()).toContain("IC");
  });
});

describe("資格外活動許可・在留資格の目安", () => {
  it("記載の読み取り", () => {
    expect(outsidePermission({ outsideActivity: "0" }, today).kind).toBe("none");
    expect(outsidePermission({ outsideActivity: "2" }, today)).toMatchObject({ kind: "comprehensive", detail: expect.stringContaining("教育") });
    expect(outsidePermission({ outsideActivity: "許可(個別)" }, today).kind).toBe("individual");
  });
  it("技能と技能実習を取り違えない", () => {
    expect(statusHint("技能実習2号ロ")).toContain("実習");
    expect(statusHint("技能")).toContain("熟練");
    expect(statusHint("永住者")).toBeNull();
  });
});
