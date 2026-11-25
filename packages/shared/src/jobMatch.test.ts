import { describe, expect, it } from "vitest";
import { judgeJobMatch, type JobCategory } from "./jobMatch.js";

const today = "2026-11-25";
const job = (v: Partial<JobCategory> = {}): JobCategory => ({ name: "製造ライン", simpleWork: false, adultEntertainment: false, sswField: null, ...v });
const card = (statusOfResidence: string, workRestriction: string, outsideActivity: string | null = null) => ({ statusOfResidence, workRestriction, outsideActivity });

describe("職種照合(テスト運用)", () => {
  it("職種が未設定なら none。身分系はどの職種でも問題なし", () => {
    expect(judgeJobMatch({ card: card("永住者", "1"), personSswField: null, job: null, lastCheck: null }, today).level).toBe("none");
    expect(judgeJobMatch({ card: card("永住者", "1"), personSswField: null, job: job({ simpleWork: true, adultEntertainment: true }), lastCheck: null }, today).level).toBe("ok");
  });
  it("留学生: 資格外活動許可(包括)なら問題なし、風俗営業は不可、許可なしは不可", () => {
    const study = card("留学", "9", "許可:原則週28時間以内・風俗営業等の従事を除く");
    expect(judgeJobMatch({ card: study, personSswField: null, job: job({ simpleWork: true }), lastCheck: null }, today)).toMatchObject({ level: "ok", checks: [expect.stringContaining("28")] });
    expect(judgeJobMatch({ card: study, personSswField: null, job: job({ adultEntertainment: true }), lastCheck: null }, today).level).toBe("ng");
    expect(judgeJobMatch({ card: card("留学", "9", "0"), personSswField: null, job: job(), lastCheck: null }, today).level).toBe("ng");
  });
  it("特定技能: 指定書の分野と職種の分野で照合", () => {
    const ssw = card("特定技能1号", "4");
    expect(judgeJobMatch({ card: ssw, personSswField: "food_manufacturing", job: job({ sswField: "food_manufacturing" }), lastCheck: null }, today).level).toBe("check");
    expect(judgeJobMatch({ card: ssw, personSswField: "food_manufacturing", job: job({ sswField: "food_manufacturing" }), lastCheck: { result: "ok", checkedAt: "2026-11-20T00:00:00Z" } }, today).level).toBe("ok");
    expect(judgeJobMatch({ card: ssw, personSswField: "kaigo", job: job({ sswField: "food_manufacturing" }), lastCheck: null }, today).level).toBe("ng");
    expect(judgeJobMatch({ card: ssw, personSswField: null, job: job({ sswField: "kaigo" }), lastCheck: null }, today).reasons[0]).toContain("指定書");
    expect(judgeJobMatch({ card: ssw, personSswField: "kaigo", job: job(), lastCheck: null }, today).reasons[0]).toContain("分野が設定されていません");
  });
  it("技人国: 要確認。単純作業を含む職種は確認済みでも要確認のまま", () => {
    const gj = card("技術・人文知識・国際業務", "2");
    const r = judgeJobMatch({ card: gj, personSswField: null, job: job({ name: "品質管理" }), lastCheck: null }, today);
    expect(r.level).toBe("check");
    expect(r.checks.length).toBeGreaterThanOrEqual(3);
    expect(judgeJobMatch({ card: gj, personSswField: null, job: job({ name: "品質管理" }), lastCheck: { result: "ok", checkedAt: "2026-11-20" } }, today).level).toBe("ok");
    const simple = judgeJobMatch({ card: gj, personSswField: null, job: job({ simpleWork: true }), lastCheck: { result: "ok", checkedAt: "2026-11-20" } }, today);
    expect(simple.level).toBe("check");
    expect(simple.reasons[0]).toContain("単純作業");
  });
  it("風俗営業に当たる職種は、身分系以外の就労資格では不可", () => {
    expect(judgeJobMatch({ card: card("技能", "2"), personSswField: null, job: job({ adultEntertainment: true }), lastCheck: null }, today).level).toBe("ng");
  });
});
