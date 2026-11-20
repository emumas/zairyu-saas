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
