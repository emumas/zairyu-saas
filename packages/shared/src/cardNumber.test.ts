import { describe, expect, it } from "vitest";
import {
  extractCardNumberCandidates,
  isValidCardNumber,
  normalizeCardNumberInput,
} from "./cardNumber.js";

describe("isValidCardNumber", () => {
  it("英字2+数字8+英字2を受け付ける", () => {
    expect(isValidCardNumber("AB12345678CD")).toBe(true);
  });
  it.each(["AB1234567CD", "A112345678CD", "AB12345678C1", "ab12345678cd", "AB12345678CDE", ""])(
    "%s は不正",
    (v) => expect(isValidCardNumber(v)).toBe(false),
  );
});

describe("normalizeCardNumberInput", () => {
  it("全角・小文字・空白・ハイフンを吸収する", () => {
    expect(normalizeCardNumberInput("ａｂ 1234-5678 ｃｄ")).toBe("AB12345678CD");
  });
});

describe("extractCardNumberCandidates", () => {
  it("券面テキストから番号を取り出す", () => {
    const text = "在留カード RESIDENCE CARD\n番号 AB12345678CD\n氏名 NAME";
    expect(extractCardNumberCandidates(text)).toEqual(["AB12345678CD"]);
  });
  it("位置に応じて O/0, I/1 などの誤読を補正する", () => {
    expect(extractCardNumberCandidates("A8 I2345O78 CD")).toEqual(["AB12345078CD"]); // 行内の空白は詰める
    expect(extractCardNumberCandidates("A8I2345\nO78CD")).toEqual([]); // 行をまたいだものは拾わない
    expect(extractCardNumberCandidates("A8I2345O78CD")).toEqual(["AB12345078CD"]);
  });
  it("券面らしい OCR 全文(他の英数字・日付が混ざる)から番号だけを拾う", () => {
    const text = [
      "日本国政府 在留カード",
      "番号 NO. AB12345678CD",
      "氏名 NGUYEN VAN A",
      "生年月日 1995年04月01日 性別 M. 国籍・地域 VIETNAM",
      "在留期間(満了日) 3年 (2029年06月20日)",
      "このカードは 2029年06月20日まで有効",
    ].join("\n");
    expect(extractCardNumberCandidates(text)[0]).toBe("AB12345678CD");
  });

  it("候補がなければ空配列", () => {
    expect(extractCardNumberCandidates("NO NUMBER HERE")).toEqual([]);
  });
});
