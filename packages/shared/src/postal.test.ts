import { describe, expect, it } from "vitest";
import { bestPrefix, fixChomeNumerals, formatPostalCode, matchTown, normalizePostalCode, parseKenAll, PREFECTURES, splitPrefecture, type PostalRow } from "./postal.js";

// 日本郵便 utf_ken_all.csv と同じ形式の行(実データの書き方を写したもの)
const row = (code: string, pref: string, city: string, town: string) => `13104,"160  ","${code}","ﾄｳｷｮｳﾄ","ｼﾝｼﾞｭｸｸ","ﾆｼｼﾝｼﾞｭｸ","${pref}","${city}","${town}",0,0,1,0,0,0`;
const KEN_ALL = [
  row("1600000", "東京都", "新宿区", "以下に掲載がない場合"),
  row("1600023", "東京都", "新宿区", "西新宿（次のビルを除く）"),
  row("1636090", "東京都", "新宿区", "西新宿新宿アイランドタワー（地階・階層不明）"),
  row("1636001", "東京都", "新宿区", "西新宿新宿アイランドタワー（１階）"),
  row("1690073", "東京都", "新宿区", "百人町"),
  row("0600042", "北海道", "札幌市中央区", "大通西（１～１９丁目）"),
  row("0640820", "北海道", "札幌市中央区", "大通西（２０～２８丁目）"),
  row("1000000", "東京都", "千代田区", "以下に掲載がない場合"),
  row("1980000", "東京都", "西多摩郡奥多摩町", "奥多摩町一円"),
  // 複数行に分かれた町域名
  row("0285102", "岩手県", "岩手郡葛巻町", "葛巻（第４０地割「５７番地１２５、１７６を除く」～"),
  row("0285102", "岩手県", "岩手郡葛巻町", "第４５地割）"),
  row("3600000", "埼玉県", "熊谷市", "以下に掲載がない場合"),
  row("3600012", "埼玉県", "熊谷市", "上之"),
  row("3400000", "埼玉県", "北葛飾郡杉戸町", "以下に掲載がない場合"),
  row("2390831", "神奈川県", "横須賀市", "久里浜"),
  row("3200861", "栃木県", "宇都宮市", "西ケ原"),
].join("\r\n");

describe("parseKenAll", () => {
  const rows = parseKenAll(KEN_ALL);
  const of = (code: string) => rows.filter((r) => r.code === code);
  it("かっこ書きを除き、市区町村全体の番号は町域を空にする", () => {
    expect(of("1600023")).toEqual([{ code: "1600023", pref: "東京都", city: "新宿区", town: "西新宿", townKey: "西新宿" }]);
    expect(of("1600000")[0]).toMatchObject({ town: "", townKey: "" });
    expect(of("1980000")[0]).toMatchObject({ town: "" });
  });
  it("高層ビルの階ごとの番号は使わない", () => {
    expect(of("1636001")).toEqual([]);
    expect(of("1636090")).toEqual([]);
  });
  it("複数行に分かれた町域名をつなぐ", () => {
    expect(of("0285102")).toEqual([expect.objectContaining({ town: "葛巻" })]);
  });
});

describe("住所との照合", () => {
  const rows = parseKenAll(KEN_ALL);
  const lookup = (address: string) => {
    const { pref, rest } = splitPrefecture(address);
    const cityRows = rows.filter((r) => r.pref === pref && rest.startsWith(r.city));
    const city = cityRows.reduce((a, r) => (r.city.length > a.length ? r.city : a), "");
    return matchTown(
      rows.filter((r): r is PostalRow => r.pref === pref && r.city === city),
      rest.slice(city.length),
    );
  };
  it("町域まで一致すれば 1 つに決まる(番地・建物名は無視)", () => {
    expect(lookup("東京都新宿区西新宿2-8-1 都庁ビル")).toMatchObject({ postalCode: "1600023", level: "town" });
    expect(lookup("東京都　新宿区　百人町１－２－３")).toMatchObject({ postalCode: "1690073" });
    expect(lookup("栃木県宇都宮市西ヶ原1-1")).toMatchObject({ postalCode: "3200861" }); // ヶ と ケ
  });
  it("町域が見つからなければ市区町村全体の番号", () => {
    expect(lookup("東京都新宿区存在しない町1-1")).toMatchObject({ postalCode: "1600000", level: "city" });
    expect(lookup("東京都西多摩郡奥多摩町氷川1")).toMatchObject({ postalCode: "1980000", level: "city" });
  });
  it("同じ町域名で番号が分かれる地域は候補を返す(自動では決めない)", () => {
    const r = lookup("北海道札幌市中央区大通西10丁目");
    expect(r.postalCode).toBeNull();
    expect(r.candidates.map((c) => c.code)).toEqual(["0600042", "0640820"]);
  });
});

describe("郵便番号の書式", () => {
  it("入力をそろえる", () => {
    expect(normalizePostalCode("〒160-0023")).toBe("1600023");
    expect(normalizePostalCode("１６０－００２３")).toBe("1600023");
    expect(normalizePostalCode("160-002")).toBeNull();
    expect(formatPostalCode("1600023")).toBe("160-0023");
  });
});

describe("bestPrefix(OCR の地名の読み違い)", () => {
  it("取り違えやすい文字と 1 文字の違いを許して、地名の先頭を当てる", () => {
    expect(bestPrefix("岐卓県大垣市", ["岐阜県", "愛知県"])).toMatchObject({ name: "岐阜県", consumed: 3, distance: 1 });
    expect(bestPrefix("西ヶ原1-2-3", ["西ケ原", "西原"])).toMatchObject({ name: "西ケ原", consumed: 3, distance: 0 });
    expect(bestPrefix("新栄ニ丁目16番", ["新栄二丁目", "新栄一丁目", "新栄"])).toMatchObject({ name: "新栄二丁目", consumed: 5, distance: 0 });
    expect(bestPrefix("大垣币本町", ["大垣市"])).toMatchObject({ name: "大垣市", consumed: 3 });
  });
  it("2 文字以下の名前は文字違いを許さない。決まらなければ null", () => {
    expect(bestPrefix("北区", ["中区"])).toBeNull();
    expect(bestPrefix("本町1丁目", ["本町", "元町"])).toMatchObject({ name: "本町" });
    expect(bestPrefix("xyz", ["岐阜県"])).toBeNull();
  });
  it("都道府県の一覧", () => {
    expect(PREFECTURES).toHaveLength(47);
    expect(PREFECTURES[0]).toBe("北海道");
  });
});

describe("fixChomeNumerals", () => {
  it("丁目の前のカタカナの読み違いを漢数字に", () => {
    expect(fixChomeNumerals("新栄ニ丁目16番")).toBe("新栄二丁目16番");
    expect(fixChomeNumerals("本町ー丁目")).toBe("本町一丁目");
    expect(fixChomeNumerals("西新宿二丁目")).toBe("西新宿二丁目");
    expect(fixChomeNumerals("十ニ丁目")).toBe("十ニ丁目"); // 前が漢数字なら触らない
  });
});
