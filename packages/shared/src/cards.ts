/** カード登録 API の入出力(mobile / web / api で共有) */
import { z } from "zod";
import { addressInput } from "./address.js";
import { CARD_NUMBER_PATTERN } from "./cardNumber.js";
import { dateString } from "./persons.js";

export const EF_PATHS = [
  "mf/ef01",
  "mf/ef02",
  "df1/ef01",
  "df1/ef02",
  "df1/ef03",
  "df1/ef04",
  "df2/ef01",
  "df2/ef02",
  "df2/ef03",
  "df2/ef04",
  "df3/ef01",
] as const;

const base64 = (maxChars: number) => z.string().max(maxChars).regex(/^[A-Za-z0-9+/]*={0,2}$/, "base64 で送ってください");

/** 端末が読み出した IC の EF(復号済み)。1 EF 最大 7004 バイト */
export const icReadPayload = z.object({
  format: z.enum(["legacy", "gen2", "tokutei"]),
  kind: z.enum(["residence", "special_permanent"]),
  files: z.partialRecord(z.enum(EF_PATHS), base64(12_000)),
});
export type IcReadPayload = z.infer<typeof icReadPayload>;

export const cardNumberInput = z
  .string()
  .regex(CARD_NUMBER_PATTERN, "在留カード番号は英字2文字+数字8桁+英字2文字です");

export const WORK_RESTRICTIONS = ["1", "2", "4", "9"] as const;
export const WORK_RESTRICTION_LABEL: Record<(typeof WORK_RESTRICTIONS)[number], string> = {
  "1": "就労制限なし",
  "2": "在留資格に基づく就労活動のみ可",
  "4": "指定書により指定された就労活動のみ可",
  "9": "就労不可",
};

/**
 * 券面から(OCR・目視で)入力した項目。旧様式は IC に文字情報が無いのでこれが値になる。
 * 第2世代・特定は IC の値が優先され、入力があれば照合に使う
 */
export const cardManualFields = z.object({
  expiryDate: dateString.nullish(),
  cardValidUntil: dateString.nullish(),
  statusOfResidence: z.string().trim().max(50).nullish(),
  workRestriction: z.enum(WORK_RESTRICTIONS).nullish(),
  pendingApplication: z.boolean().optional(),
  /** カード記載の生年月日・性別・国籍(旧様式は券面の読み取り・入力。第2世代は IC の値を使い、これは照合に使う) */
  birthDate: dateString.nullish(),
  sex: z.enum(["M", "F"]).nullish(),
  nationality: z.string().trim().max(50).nullish(),
  /** 住居地(撮影画像の端末内 OCR か手入力。IC に裏面の記載があればサーバーはそちらを採用する) */
  address: addressInput.nullish(),
  addressSource: z.enum(["back_photo", "front_photo", "manual"]).nullish(),
});
export type CardManualFields = z.infer<typeof cardManualFields>;

/** 撮影画像(端末で JPEG に圧縮して送る。最大 3MB) */
export const cardPhoto = z.object({
  contentType: z.enum(["image/jpeg", "image/png"]),
  data: base64(4_000_000),
});

export const cardVerifyInput = z.object({
  personId: z.uuid(),
  cardNumber: cardNumberInput,
  ic: icReadPayload,
  manual: cardManualFields.default({}),
});

export const cardRegisterInput = z.object({
  personId: z.uuid(),
  cardNumber: cardNumberInput,
  /** IC が読めなかった場合は null(IC 未検証として登録) */
  ic: icReadPayload.nullable(),
  icFailureReason: z.enum(["unreadable", "unsupported_device", "other"]).optional(),
  manual: cardManualFields.default({}),
  photos: z.object({ front: cardPhoto.optional(), back: cardPhoto.optional() }).default({}),
  /** 券面と IC の差分がある場合の理由(必須) */
  diffReason: z.string().trim().min(1).max(500).optional(),
  deviceId: z.string().max(100).optional(),
});
export type CardRegisterInput = z.infer<typeof cardRegisterInput>;

/**
 * 登録済みカードの記載事項の修正(保存済みの撮影画像の端末内 OCR や目視で)。
 * 送った項目だけ変える。IC の値(第2世代の券面記載事項、IC の裏面追記の住居地)は変えられない
 */
export const cardDetailsUpdateInput = z.object({
  cardId: z.uuid(),
  birthDate: dateString.nullable().optional(),
  sex: z.enum(["M", "F"]).nullable().optional(),
  nationality: z.string().trim().max(50).nullable().optional(),
  address: addressInput.nullable().optional(),
  addressSource: z.enum(["back_photo", "front_photo", "manual"]).optional(),
  /** 旧様式のみ(IC に文字情報が無いため) */
  statusOfResidence: z.string().trim().max(50).nullable().optional(),
  expiryDate: dateString.nullable().optional(),
  cardValidUntil: dateString.nullable().optional(),
});
export type CardDetailsUpdateInput = z.infer<typeof cardDetailsUpdateInput>;
