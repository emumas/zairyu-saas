import { describe, expect, it } from "vitest";
import { noticeDueDate, noticeFields, noticeForm, noticeRecordInput, type NoticeSource } from "./notices.js";

describe("外国人雇用状況の届出の期限", () => {
  it("雇用保険の被保険者: 雇入れは翌月10日、離職は離職日の翌日(喪失日)の翌日から10日以内", () => {
    expect(noticeDueDate("hire", "2026-11-24", true)).toBe("2026-12-10");
    expect(noticeDueDate("hire", "2026-12-31", true)).toBe("2027-01-10");
    expect(noticeDueDate("separation", "2026-11-30", true)).toBe("2026-12-11");
  });
  it("被保険者でない人: 雇入れ・離職とも翌月末日(うるう年・年またぎ)", () => {
    expect(noticeDueDate("hire", "2028-01-15", false)).toBe("2028-02-29");
    expect(noticeDueDate("separation", "2026-12-01", false)).toBe("2027-01-31");
  });
  it("未設定は早いほうの期限", () => {
    expect(noticeDueDate("hire", "2026-11-24", null)).toBe("2026-12-10");
    expect(noticeDueDate("separation", "2026-11-30", null)).toBe("2026-12-11");
  });
  it("書式の名前", () => {
    expect(noticeForm("hire", true)).toContain("資格取得届");
    expect(noticeForm("separation", false)).toContain("様式第3号");
    expect(noticeForm("hire", null)).toContain("未設定");
  });
});

describe("記入内容", () => {
  const base: NoticeSource = {
    kind: "hire",
    eventDate: "2026-11-24",
    name: "NGUYEN VAN A",
    nameKana: "グエン ヴァン アー",
    birthDate: "1995-04-01",
    sex: "M",
    nationality: "ベトナム",
    statusOfResidence: "留学",
    expiryDate: "2028-03-31",
    cardValidUntil: null,
    outsideActivity: "許可:原則週28時間以内・風俗営業等の従事を除く",
    outsideActivityUntil: null,
    cardNumberMasked: "AB******78CD",
    site: { officialName: "株式会社例 本社", name: "本社", address: "東京都新宿区西新宿2-8-1", phone: "03-0000-0000", insuranceOfficeNumber: null },
    employer: { name: "株式会社例", address: "東京都新宿区西新宿2-8-1", phone: "03-0000-0000", representativeName: "例 太郎" },
  };
  it("様式の欄の順に値を並べ、空欄は null", () => {
    const f = noticeFields(base, "2026-11-24");
    expect(f.map((x) => x.label).slice(0, 3)).toEqual(["外国人の氏名(ローマ字)", "フリガナ", "在留資格"]);
    expect(f.find((x) => x.label === "資格外活動許可の有無")?.value).toBe("有");
    expect(f.find((x) => x.label === "性別")?.value).toBe("男");
    expect(f.find((x) => x.label === "雇入れ年月日")?.value).toBe("2026-11-24");
    expect(f.find((x) => x.label === "雇用保険適用事業所番号")).toMatchObject({ value: null, optional: true });
    expect(f.find((x) => x.label === "在留カード番号")).toMatchObject({ secret: true });
  });
  it("永住者は在留期間の定めなし。資格外活動が無ければ「無」", () => {
    const f = noticeFields({ ...base, statusOfResidence: "永住者", expiryDate: null, outsideActivity: "0" }, "2026-11-24");
    expect(f.find((x) => x.label.startsWith("在留期間"))?.value).toBe("在留期間の定めなし");
    expect(f.find((x) => x.label === "資格外活動許可の有無")?.value).toBe("無");
  });
  it("記録の入力: 提出なら提出日、不要なら理由が必要", () => {
    const ok = { personId: "6f1b2c3d-1111-4a2b-8c3d-1234567890ab", kind: "hire", eventDate: "2026-11-24" } as const;
    expect(noticeRecordInput.safeParse({ ...ok, status: "submitted" }).success).toBe(false);
    expect(noticeRecordInput.safeParse({ ...ok, status: "submitted", submittedOn: "2026-11-30", method: "hellowork_internet" }).success).toBe(true);
    expect(noticeRecordInput.safeParse({ ...ok, status: "not_required" }).success).toBe(false);
    expect(noticeRecordInput.safeParse({ ...ok, status: "not_required", note: "特別永住者" }).success).toBe(true);
  });
});
