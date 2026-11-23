import { describe, expect, it } from "vitest";
import { addressFromFrontOcr, backHasEntries, nameFromFrontOcr, nationalityCode, chooseAddress, cleanAddress, countryName, frontFieldsFromOcr, japaneseDate, latestAddressFromBackOcr } from "./address.js";

describe("addressFromFrontOcr", () => {
  it("住居地の欄を取り出す(項目名を除き、続きの行をつなぐ)", () => {
    const lines = [
      { text: "氏名 NAME NGUYEN VAN A", top: 100 },
      { text: "国籍・地域 ベトナム", top: 200 },
      { text: "住居地 東京都新宿区西新宿二丁目", top: 300 },
      { text: "8番1号 101号室", top: 330 },
      { text: "在留資格 技術・人文知識・国際業務", top: 400 },
    ];
    expect(addressFromFrontOcr(lines)).toBe("東京都新宿区西新宿二丁目 8番1号 101号室");
  });
  it("項目名と住所が別の行でも、行の順番がばらばらでも読める", () => {
    expect(addressFromFrontOcr([{ text: "大阪府大阪市北区梅田1-1-1", top: 320 }, { text: "住居地", top: 300 }])).toBe("大阪府大阪市北区梅田1-1-1");
  });
  it("2 行目が数字だけ・建物名だけでも、間に項目名(ADDRESS)が挟まってもつなぐ", () => {
    const lines = [
      { text: "住居地 愛知県名古屋市中区新栄二丁目16番28号 西三宝ビル5", top: 300, left: 60, height: 20 },
      { text: "ADDRESS", top: 318, left: 10, height: 14 },
      { text: "02号", top: 324, left: 62, height: 20 },
      { text: "在留資格 永住者", top: 380, left: 10, height: 20 },
    ];
    expect(addressFromFrontOcr(lines)).toBe("愛知県名古屋市中区新栄二丁目16番28号 西三宝ビル5 02号");
    expect(addressFromFrontOcr([{ text: "東京都新宿区西新宿2-8-1", top: 300 }, { text: "メゾン新宿", top: 325 }, { text: "在留資格 技能", top: 380 }])).toBe("東京都新宿区西新宿2-8-1 メゾン新宿");
  });
  it("離れた行(高さの 2.5 倍より下)はつながない", () => {
    expect(addressFromFrontOcr([{ text: "東京都新宿区西新宿2-8-1", top: 300, height: 20 }, { text: "メゾン新宿", top: 400, height: 20 }])).toBe("東京都新宿区西新宿2-8-1");
  });
  it("住所が無ければ null", () => {
    expect(addressFromFrontOcr([{ text: "在留カード RESIDENCE CARD" }, { text: "AB12345678CD" }])).toBeNull();
  });
});

describe("latestAddressFromBackOcr", () => {
  it("いちばん下の記載を最新として採用し、届出日を除く", () => {
    const lines = [
      { text: "届出年月日 住居地 記載者印", top: 50 },
      { text: "2024年4月1日 神奈川県横浜市中区本町1-1", top: 100 },
      { text: "2025年10月5日 埼玉県さいたま市浦和区高砂3-15-1", top: 160 },
      { text: "さいたまハイツ205", top: 185 },
      { text: "資格外活動許可欄", top: 400 },
    ];
    expect(latestAddressFromBackOcr(lines)).toBe("埼玉県さいたま市浦和区高砂3-15-1 さいたまハイツ205");
  });
  it("届出年月日は、行の前後・次の行・和暦・全角でも住所に入れない", () => {
    const base = { text: "届出年月日 住居地 記載者印", top: 50 };
    // 日付が住所の後ろに付く
    expect(latestAddressFromBackOcr([base, { text: "岐阜県大垣市本町1丁目12番地7 2025.02.14", top: 100 }])).toBe("岐阜県大垣市本町1丁目12番地7");
    // 日付だけの行が住所の次に来る(続きの行としてつながない)
    expect(latestAddressFromBackOcr([base, { text: "岐阜県大垣市本町1丁目12番地7", top: 100 }, { text: "2025年2月14日", top: 104 }])).toBe("岐阜県大垣市本町1丁目12番地7");
    // 和暦・全角
    expect(latestAddressFromBackOcr([base, { text: "令和7年2月14日 岐阜県大垣市本町1丁目12番地7", top: 100 }])).toBe("岐阜県大垣市本町1丁目12番地7");
    expect(latestAddressFromBackOcr([base, { text: "２０２５．０２．１４ 岐阜県大垣市本町１丁目１２番地７", top: 100 }])).toBe("岐阜県大垣市本町1丁目12番地7");
    expect(latestAddressFromBackOcr([base, { text: "R7.2.14岐阜県大垣市本町1丁目12番地7 メゾン大垣101", top: 100 }])).toBe("岐阜県大垣市本町1丁目12番地7 メゾン大垣101");
    // 建物名の続きの行に日付が混ざっても除く
    expect(latestAddressFromBackOcr([base, { text: "岐阜県大垣市本町1丁目12番地7", top: 100 }, { text: "2025年2月14日 メゾン大垣101", top: 104 }])).toBe("岐阜県大垣市本町1丁目12番地7 メゾン大垣101");
  });
  it("裏面: 2 行目(建物名・部屋番号)を、届出年月日・印影の行を飛ばしてつなぐ。次の記載ではやめる", () => {
    const base = { text: "届出年月日 住居地 記載者印", top: 50 };
    expect(
      latestAddressFromBackOcr([
        base,
        { text: "2024年4月1日", top: 100 },
        { text: "岐阜県大垣市本町1丁目12番地7", top: 100 },
        { text: "大垣市長之印", top: 104 },
        { text: "コーポ本町 201号室", top: 122 },
      ]),
    ).toBe("岐阜県大垣市本町1丁目12番地7 コーポ本町 201号室");
    expect(
      latestAddressFromBackOcr([base, { text: "岐阜県大垣市本町1丁目12番地7", top: 100 }, { text: "2025年2月14日 愛知県一宮市本町2-3-4", top: 130 }]),
    ).toBe("愛知県一宮市本町2-3-4");
  });
  it("記載が無ければ null", () => {
    expect(latestAddressFromBackOcr([{ text: "届出年月日 住居地 記載者印", top: 50 }, { text: "在留期間更新等許可申請欄", top: 300 }])).toBeNull();
  });
});

describe("chooseAddress", () => {
  it("IC の裏面追記 > 裏面の読み取り > 表面の読み取り", () => {
    expect(chooseAddress({ icBack: "千葉県千葉市中央区1-1", backPhoto: "x県", frontPhoto: "東京都" })).toEqual({ address: "千葉県千葉市中央区1-1", source: "ic_back" });
    expect(chooseAddress({ icBack: null, backPhoto: "埼玉県さいたま市1", frontPhoto: "東京都新宿区1" })).toEqual({ address: "埼玉県さいたま市1", source: "back_photo" });
    expect(chooseAddress({ frontPhoto: "東京都新宿区1" })).toEqual({ address: "東京都新宿区1", source: "front_photo" });
    expect(chooseAddress({ icBack: " ", backPhoto: "" })).toBeNull();
  });
  it("全角空白をそろえる", () => {
    expect(cleanAddress("東京都　新宿区　1-1")).toBe("東京都 新宿区 1-1");
  });
});

describe("frontFieldsFromOcr(旧様式の表面)", () => {
  const lines = [
    { text: "日本国政府 在留カード 番号 AB12345678CD", top: 10 },
    { text: "氏名 NGUYEN VAN A", top: 60 },
    { text: "生年月日 1995年4月1日 性別 男 M 国籍・地域 ベトナム", top: 110 },
    { text: "住居地 東京都新宿区西新宿2丁目8番1号", top: 160 },
    { text: "在留資格 技術・人文知識・国際業務", top: 210 },
    { text: "就労制限の有無 在留資格に基づく就労活動のみ可", top: 250 },
    { text: "在留期間(満了日) 5年(2029年06月20日)", top: 300 },
    { text: "許可年月日 2024年06月20日 交付年月日 2024年06月20日", top: 350 },
    { text: "このカードは 2029年06月20日まで有効です。", top: 400 },
  ];
  it("項目ごとに値を取り出す", () => {
    expect(frontFieldsFromOcr(lines)).toEqual({
      name: "NGUYEN VAN A",
      birthDate: "1995-04-01",
      sex: "M",
      nationality: "ベトナム",
      statusOfResidence: "技術・人文知識・国際業務",
      expiryDate: "2029-06-20",
      cardValidUntil: "2029-06-20",
      address: "東京都新宿区西新宿2丁目8番1号",
    });
  });
  it("値が次の行にあっても読む。読めない項目は null", () => {
    const r = frontFieldsFromOcr([
      { text: "生年月日", top: 10 },
      { text: "１９８８年１２月３１日", top: 30 },
      { text: "性別 女 F", top: 50 },
    ]);
    expect(r).toMatchObject({ birthDate: "1988-12-31", sex: "F", nationality: null, statusOfResidence: null, expiryDate: null, address: null });
  });
  it("国籍は項目名の読み違いが残っても国名だけを取る", () => {
    expect(countryName("国籍・地域 フィリピン")).toBe("フィリピン");
    expect(countryName("·地滅 フィリピン")).toBe("フィリピン");
    expect(countryName("国籍・地域 NATIONALITY/REGION 中国")).toBe("中国");
    expect(countryName("NATIONALITY/REGION ベトナム")).toBe("ベトナム");
    expect(countryName("国籍・地域")).toBeNull();
    const r = frontFieldsFromOcr([
      { text: "生年月日 1990年1月1日 性別 女 F", top: 100 },
      { text: "国籍·地滅 フィリピン", top: 120 },
    ]);
    expect(r.nationality).toBe("フィリピン");
  });

  it("japaneseDate は存在しない日付を拒否する", () => {
    expect(japaneseDate("2025年2月30日")).toBeNull();
    expect(japaneseDate("2024年2月29日")).toBe("2024-02-29");
  });
});

describe("裏面に記載があるのに住所が読めないとき", () => {
  it("表面の古い住所を使わない", () => {
    const lines = [{ text: "届出年月日 住居地 記載者印" }, { text: "2025年2月14日" }, { text: "(読めない文字)" }];
    expect(backHasEntries(lines)).toBe(true);
    expect(backHasEntries([{ text: "届出年月日 住居地 記載者印" }])).toBe(false);
    // 下の欄(申請欄の押印など)の日付は住居地の記載ではない
    expect(backHasEntries([{ text: "届出年月日 住居地 記載者印", top: 10 }, { text: "在留期間更新等許可申請欄", top: 300 }, { text: "2025.02.14 申請中", top: 320 }])).toBe(false);
    expect(chooseAddress({ backPhoto: null, frontPhoto: "東京都新宿区西新宿2-8-1", backHasEntries: true })).toBeNull();
    expect(chooseAddress({ backPhoto: null, frontPhoto: "東京都新宿区西新宿2-8-1", backHasEntries: false })).toEqual({ address: "東京都新宿区西新宿2-8-1", source: "front_photo" });
  });
});

describe("氏名と国籍(登録者の下書き)", () => {
  it("氏名の欄のローマ字を取り出す(同じ行・次の行)", () => {
    expect(nameFromFrontOcr(["日本国政府 在留カード", "氏名 KATO EDEN GARCIA", "NAME", "生年月日 1990年1月2日"])).toBe("KATO EDEN GARCIA");
    expect(nameFromFrontOcr(["氏名", "NGUYEN VAN A", "生年月日"])).toBe("NGUYEN VAN A");
    expect(nameFromFrontOcr(["氏名 NAME", "生年月日"])).toBeNull();
    expect(nameFromFrontOcr(["在留資格"])).toBeNull();
  });
  it("国籍の表記を国コードに。分からなければ null", () => {
    expect(nationalityCode("フィリピン")).toBe("PHL");
    expect(nationalityCode("ベトナム")).toBe("VNM");
    expect(nationalityCode("vnm")).toBe("VNM");
    expect(nationalityCode("中国(台湾)")).toBe("TWN");
    expect(nationalityCode("どこか")).toBeNull();
  });
});
