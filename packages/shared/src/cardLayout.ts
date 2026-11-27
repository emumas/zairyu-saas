/**
 * 旧様式の在留カード表面の配置(カードの幅・高さに対する割合)。
 * IC の券面イメージは印刷済みの項目名と顔写真を含まないため、ここで項目名と顔写真の位置を補う。
 * 値は実物のカードの配置からの目測。実カードの表示で合わせ込むこと(アプリと Web 管理画面で共有。位置の微調整はこのファイルだけで済む)
 */
export interface CardLabel {
  ja: string;
  en?: string;
  /** 左上の位置(0〜1) */
  x: number;
  y: number;
  /** 文字の大きさ(カード幅に対する割合。既定 LABEL_SIZE) */
  size?: number;
}

/** 項目名の文字の大きさ(カード幅に対する割合)。実物の印字に合わせて小さめ */
export const LABEL_SIZE = 0.018;
export const LABEL_EN_SIZE = 0.0115;

export const LEGACY_FRONT_LABELS: CardLabel[] = [
  { ja: "日本国政府", en: "GOVERNMENT OF JAPAN", x: 0.024, y: 0.035, size: 0.03 },
  { ja: "在 留 カ ー ド", en: "RESIDENCE CARD", x: 0.39, y: 0.03, size: 0.036 },
  { ja: "番号", en: "No.", x: 0.705, y: 0.055 },
  { ja: "氏名", en: "NAME", x: 0.026, y: 0.135 },
  { ja: "生年月日", en: "DATE OF BIRTH", x: 0.024, y: 0.24 },
  { ja: "性別", en: "SEX", x: 0.372, y: 0.24 },
  { ja: "国籍・地域", en: "NATIONALITY/REGION", x: 0.487, y: 0.24 },
  { ja: "住居地", en: "ADDRESS", x: 0.024, y: 0.355 },
  { ja: "在留資格", en: "STATUS", x: 0.024, y: 0.46 },
  { ja: "就労制限の有無", x: 0.25, y: 0.545, size: 0.016 },
  { ja: "在留期間(満了日)", en: "PERIOD OF STAY\n(DATE OF EXPIRATION)", x: 0.024, y: 0.645 },
  { ja: "許可の種類", x: 0.024, y: 0.765 },
  { ja: "許可年月日", x: 0.024, y: 0.83 },
  { ja: "交付年月日", x: 0.358, y: 0.83 },
  { ja: "このカードは", x: 0.024, y: 0.885 },
  // 「PERIOD OF VALIDITY OF THIS CARD」は IC の券面イメージ側に含まれる
  { ja: "です。", x: 0.665, y: 0.885 },
];

/** 顔写真の枠(割合) */
export const LEGACY_FACE_BOX = { x: 0.711, y: 0.305, width: 0.268, height: 0.554 };

/** 淡い帯(就労制限の欄・有効期限の欄) */
export const LEGACY_BANDS = [
  { x: 0, y: 0.0, width: 1, height: 0.12 },
  { x: 0.247, y: 0.516, width: 0.446, height: 0.11 },
  { x: 0, y: 0.875, width: 0.73, height: 0.075 },
];

// ---------------------------------------------------------------- 第2世代・特定在留カード
// IC に券面イメージが無いので、IC の文字情報(券面記載事項)と氏名・住居地・顔の画像から組み立てる。
// 配置は旧様式に合わせた目安(実物の第2世代の券面の配置とは異なる場合がある)

/** カードの上に描く文字(位置・大きさはカードに対する割合) */
export interface CardText {
  text: string;
  x: number;
  y: number;
  size: number;
}

export interface CardFaceFields {
  birthDate?: string | null;
  sex?: string | null;
  nationality?: string | null;
  statusOfResidence?: string | null;
  workRestriction?: string | null;
  periodOfStay?: string | null;
  permissionType?: string | null;
  permittedAt?: string | null;
  expiryDate?: string | null;
  cardValidUntil?: string | null;
}

/**
 * 第2世代の券面の配置(実物の券面から目測。2026-11-27)。
 * 項目名の右に値が並ぶ(旧様式と違い、許可の種類・許可年月日は券面に無い。番号は左下)
 */
export const GEN2_NAME_BOX = { x: 0.075, y: 0.155, width: 0.6, height: 0.085 };
export const GEN2_ADDRESS_BOX = { x: 0.075, y: 0.295, width: 0.645, height: 0.1 };
export const GEN2_FACE_BOX = { x: 0.73, y: 0.37, width: 0.22, height: 0.47 };
/** 淡い帯(就労制限の有無の枠・有効期限の欄) */
export const GEN2_BANDS = [
  { x: 0.21, y: 0.49, width: 0.55, height: 0.085 },
  { x: 0, y: 0.88, width: 0.73, height: 0.08 },
];
/** 券面の地の色(淡い桃色) */
export const GEN2_BACKGROUND = "#f8f0f1";

const VALUE_SIZE = 0.03;

/** 2027-11-25 → 2027年11月25日 */
export function jaDate(d: string | null | undefined): string | null {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : (d ?? null);
}

/** 在留期間(IC の値: YYMM・DDD・無期限は 0000)→ 「3年」「6月」「90日」「無期限」 */
export function periodOfStayLabel(v: string | null | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  if (/^0+$/.test(s)) return "無期限";
  if (/^\d{4}$/.test(s)) {
    const y = Number(s.slice(0, 2));
    const m = Number(s.slice(2));
    return `${y ? `${y}年` : ""}${m ? `${m}月` : ""}` || s;
  }
  if (/^\d{1,3}$/.test(s)) return `${Number(s)}日`;
  return s;
}

/**
 * 第2世代・特定のカード表示の文字(項目名と値)。
 * labels: 項目名(旧様式と同じ形)、values: IC の値を整えたもの
 */
export function gen2FaceTexts(
  f: CardFaceFields,
  o: { kind: "residence" | "special_permanent"; cardNumber?: string | null; workRestrictionLabel?: (code: string) => string | null; nationalityLabel?: (code: string) => string | null; statusIsCode?: boolean },
): { labels: CardLabel[]; values: CardText[] } {
  const residence = o.kind === "residence";
  const labels: CardLabel[] = [
    { ja: "日本国政府", en: "GOVERNMENT OF JAPAN", x: 0.02, y: 0.075, size: 0.03 },
    residence ? { ja: "在留カード", en: "RESIDENCE CARD", x: 0.55, y: 0.065, size: 0.042 } : { ja: "特別永住者証明書", en: "SPECIAL PERMANENT RESIDENT CERTIFICATE", x: 0.45, y: 0.065, size: 0.036 },
    { ja: "氏名", en: "NAME", x: 0.02, y: 0.17 },
    { ja: "生年月日", en: "DATE OF BIRTH", x: 0.02, y: 0.235 },
    { ja: "性別", en: "SEX", x: 0.41, y: 0.235 },
    { ja: "国籍・地域", en: "NATIONALITY/REGION", x: 0.54, y: 0.235 },
    { ja: "住居地", en: "ADDRESS", x: 0.02, y: 0.3 },
    ...(residence
      ? [
          { ja: "就労制限の有無", en: "WORK RESTRICTIONS", x: 0.22, y: 0.505 },
          { ja: "在留資格", en: "STATUS", x: 0.02, y: 0.625 },
          { ja: "在留期間満了日", en: "THE EXPIRY DATE OF THE PERIOD OF STAY", x: 0.02, y: 0.69 },
        ]
      : []),
    { ja: "番号", en: "No.", x: 0.02, y: 0.815 },
    { ja: "このカードは", en: "PERIOD OF VALIDITY OF THIS CARD", x: 0.02, y: 0.895 },
    { ja: "まで有効です。", x: 0.42, y: 0.895 },
    { ja: "IMMIGRATION SERVICES AGENCY", x: 0.73, y: 0.935, size: 0.016 },
  ];
  const v: CardText[] = [];
  const put = (text: string | null | undefined, x: number, y: number, size = VALUE_SIZE) => {
    if (text) v.push({ text, x, y, size });
  };
  put(jaDate(f.birthDate), 0.125, 0.228);
  put(f.sex === "M" ? "男 M." : f.sex === "F" ? "女 F." : null, 0.46, 0.228);
  const nat = f.nationality ? (o.nationalityLabel?.(f.nationality) ?? null) : null;
  const natText = f.nationality ? (nat ? `${nat}(${f.nationality})` : f.nationality) : null;
  put(natText, 0.675, 0.228, natText && natText.length > 9 ? 0.022 : VALUE_SIZE);
  if (residence) {
    put(f.workRestriction ? (o.workRestrictionLabel?.(f.workRestriction) ?? f.workRestriction) : null, 0.47, 0.5, 0.032);
    const status = f.statusOfResidence ? (o.statusIsCode ? `コード ${f.statusOfResidence}` : f.statusOfResidence) : null;
    put(status, 0.125, 0.615, status && status.length > 10 ? 0.026 : 0.034);
    put(jaDate(f.expiryDate), 0.185, 0.672, 0.032);
  }
  put(o.cardNumber, 0.09, 0.8, 0.042);
  put(jaDate(f.cardValidUntil), 0.14, 0.88, 0.03);
  return { labels, values: v };
}
