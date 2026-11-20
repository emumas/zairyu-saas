import { describe, expect, it } from "vitest";
import { nameKanaSchema, personCreateInput, personMatchName, phoneSchema, toKatakana } from "./persons.js";

describe("フリガナ・電話番号", () => {
  it("ひらがなはカタカナに、全角空白は半角に", () => {
    expect(toKatakana("ぐえん　ヴぁん あー")).toBe("グエン ヴァン アー");
    expect(nameKanaSchema.parse("さんとす・まりあ")).toBe("サントス・マリア");
    expect(nameKanaSchema.parse("")).toBeNull();
    expect(nameKanaSchema.safeParse("NGUYEN").success).toBe(false);
    expect(nameKanaSchema.safeParse("山田").success).toBe(false);
  });
  it("電話番号は全角数字・空白・括弧をそろえる", () => {
    expect(phoneSchema.parse("０９０－１２３４－５６７８")).toBe("090-1234-5678");
    expect(phoneSchema.parse("(03) 1234 5678")).toBe("0312345678");
    expect(phoneSchema.parse("+81 90 1234 5678")).toBe("+819012345678");
    expect(phoneSchema.parse("")).toBeNull();
    expect(phoneSchema.safeParse("090-abcd").success).toBe(false);
  });
  it("登録者の入力に含められる(任意)", () => {
    const r = personCreateInput.parse({ siteId: "00000000-0000-4000-8000-000000000000", employeeCode: "E1", name: "A", nameKana: "えー", phone: "090-0000-0000" });
    expect(r).toMatchObject({ nameKana: "エー", phone: "090-0000-0000" });
  });
});

describe("同一人物の照合用の氏名", () => {
  it("全角・大文字小文字・空白の違いをそろえる", () => {
    expect(personMatchName("Nguyen  Van A")).toBe("NGUYEN VAN A");
    expect(personMatchName("ＮＧＵＹＥＮ　ＶＡＮ　Ａ")).toBe("NGUYEN VAN A");
    expect(personMatchName("SANTOS, MARIA")).toBe("SANTOS MARIA");
  });
});
