import { describe, expect, it } from "vitest";
import { diffFields, mergeFields, type IcEvaluation } from "./evaluate.js";

const gen2 = (statusOfResidence: string | null, cardNumber = "AB12345678CD") =>
  ({
    format: "gen2",
    kind: "residence",
    cardNumber,
    images: [],
    backAddress: null,
    signature: { status: "valid" },
    fields: {
      statusOfResidence,
      periodOfStay: null,
      permissionType: null,
      permittedAt: null,
      expiryDate: "2027-11-25",
      cardValidUntil: "2027-11-25",
      workRestriction: "1",
      outsideActivity: "0",
      outsideActivityUntil: null,
      pendingApplication: false,
      birthDate: "1990-01-01",
      sex: "F",
      nationality: "PHL",
    },
  }) as unknown as IcEvaluation;

describe("第2世代の在留資格コード", () => {
  it("IC がコードなら、券面の表記(名称)を保存し、照合の差分にしない", () => {
    const ic = gen2("T630100000");
    expect(mergeFields(ic, { statusOfResidence: "定住者" }).statusOfResidence).toBe("定住者");
    expect(diffFields(ic, "AB12345678CD", { statusOfResidence: "定住者" })).toEqual([]);
  });
  it("名称が無ければコードのまま", () => {
    expect(mergeFields(gen2("T630100000"), {}).statusOfResidence).toBe("T630100000");
  });
  it("IC が名称なら IC の値を優先する", () => {
    expect(mergeFields(gen2("定住者"), { statusOfResidence: "永住者" }).statusOfResidence).toBe("定住者");
  });
  it("カード番号は大文字・空白をそろえて比べる", () => {
    expect(diffFields(gen2(null, "ab12345678cd"), "AB12345678CD", {})).toEqual([]);
    expect(diffFields(gen2(null, "AB12345678CE"), "AB12345678CD", {}).map((d) => d.field)).toEqual(["cardNumber"]);
  });
});
