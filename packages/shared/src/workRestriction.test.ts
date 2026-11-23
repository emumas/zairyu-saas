import { describe, expect, it } from "vitest";
import { frontFieldsFromOcr } from "./address.js";
import { workRestrictionFromStatus, workRestrictionFromText } from "./workRestriction.js";

describe("就労制限の有無の自動判定", () => {
  it("券面の文言から(確定)", () => {
    expect(workRestrictionFromText("就労制限の有無 就労制限なし")).toBe("1");
    expect(workRestrictionFromText("在留資格に基づく就労活動のみ可")).toBe("2");
    expect(workRestrictionFromText("指定書により指定された就労活動のみ可")).toBe("4");
    expect(workRestrictionFromText("就労不可")).toBe("9");
    expect(workRestrictionFromText("就労制限の有無")).toBeNull();
  });
  it("在留資格だけで決まるものだけ。それ以外は null", () => {
    expect(workRestrictionFromStatus("永住者")).toBe("1");
    expect(workRestrictionFromStatus("日本人の配偶者等")).toBe("1");
    expect(workRestrictionFromStatus("定住者")).toBe("1");
    expect(workRestrictionFromStatus("留学")).toBe("9");
    expect(workRestrictionFromStatus("家族滞在")).toBe("9");
    expect(workRestrictionFromStatus("技術・人文知識・国際業務")).toBeNull();
    expect(workRestrictionFromStatus("特定活動")).toBeNull();
    expect(workRestrictionFromStatus(null)).toBeNull();
  });
  it("表面の OCR から読み取る", () => {
    expect(frontFieldsFromOcr([{ text: "在留資格 永住者", top: 100 }, { text: "就労制限の有無 就労制限なし", top: 120 }]).workRestriction).toBe("1");
  });
});
