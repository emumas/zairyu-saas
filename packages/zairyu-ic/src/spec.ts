/**
 * 入管庁仕様書の定数。出典は SPEC_NOTES.md を参照。
 * - legacy : 在留カード等仕様書 Ver1.5(令和6年3月)
 * - gen2   : 第２世代在留カード等仕様書 Ver1.1(令和8年4月)
 * - tokutei: 特定在留カード等仕様書 Ver1.1(令和8年4月)
 */
import { hex } from "./bytes.js";

export type CardFormat = "legacy" | "gen2" | "tokutei";

/** DF 名(AID)。3様式共通(特定在留カードは在留 AP を追加) */
export const AID = {
  /** 特定在留カードの在留 AP(個人番号カードの SSD 上) */
  residenceAp: hex("D392F0004F0100000000000000000000"),
  df1: hex("D392F0004F0200000000000000000000"),
  df2: hex("D392F0004F0300000000000000000000"),
  df3: hex("D392F0004F0400000000000000000000"),
} as const;

/** iOS の com.apple.developer.nfc.readersession.iso7816.select-identifiers に記載する AID */
export const SELECT_IDENTIFIERS = [AID.residenceAp, AID.df1, AID.df2, AID.df3];

/** MF/EF02 カード種別(タグ C1)の値 */
export const CARD_TYPE = {
  "1": { format: "legacy", kind: "residence" },
  "2": { format: "legacy", kind: "special_permanent" },
  "05": { format: "gen2", kind: "residence" },
  "06": { format: "gen2", kind: "special_permanent" },
  "07": { format: "tokutei", kind: "residence" },
  "08": { format: "tokutei", kind: "special_permanent" },
} as const satisfies Record<string, { format: CardFormat; kind: CardKind }>;

/** 在留カード / 特別永住者証明書 */
export type CardKind = "residence" | "special_permanent";

/** READ BINARY の P1(短縮 EF 指定)。DF ごとに意味が異なる */
export const READ_P1 = {
  mf: { commonData: 0x8b, cardType: 0x8a },
  legacy: {
    df1: { frontImage: 0x85, face: 0x86 },
    df2: { address: 0x81, outsideComprehensive: 0x82, outsideIndividual: 0x83, renewalStatus: 0x84 },
    df3: { signature: 0x82 },
  },
  gen2: {
    df1: { cardNumber: 0x81, faceItems: 0x83, nameAndFace: 0x84, addressImage: 0x86 },
    df2: { outsideActivity: 0x81, renewalStatus: 0x82, other: 0x83 },
    df3: { signature: 0x82 },
  },
} as const;

/** 旧様式のファイル容量(バイト)。分割読出しの上限に使う */
export const LEGACY_EF_SIZE = {
  mf: { commonData: 6, cardType: 3 },
  df1: { frontImage: 7004, face: 3004 },
  df2: { address: 342, outsideComprehensive: 122, outsideIndividual: 122, renewalStatus: 3 },
  df3: { signature: 1464 },
} as const;

/** 第2世代・特定の DF1 の EF-ID(特定在留カードは EF 選択 + オフセット読出しで分割読出しする) */
export const GEN2_EF_ID = {
  df1: { cardNumber: 0x0001, faceItems: 0x0002, nameAndFace: 0x0003, addressImage: 0x0004 },
  df2: { outsideActivity: 0x0001, renewalStatus: 0x0002, other: 0x0003 },
  df3: { signature: 0x0001 },
} as const;

/** ファイル容量(バイト)。分割読出しの上限に使う */
export const GEN2_EF_SIZE = {
  mf: { commonData: 6, cardType: 4 },
  df1: { cardNumber: 14, faceItems: 73, nameAndFace: 5508, addressImage: 2505 },
  df2: { outsideActivity: 22, renewalStatus: 3, other: 207 },
  df3: { signature: 704 },
} as const;

/** TLV タグ */
export const TAG = {
  specVersion: 0xc0,
  cardType: 0xc1,
  // legacy
  frontImage: 0xd0, // legacy: 券面(表)イメージ 7000 / gen2: 氏名イメージ 2500
  face: 0xd1, // 顔画像 3000
  legacyAddressDate: 0xd2,
  legacyMunicipality: 0xd3,
  legacyAddress: 0xd4,
  legacyOutsideComprehensive: 0xd5,
  legacyOutsideIndividual: 0xd6,
  legacyRenewalStatus: 0xd7,
  rsaCheckCode: 0xda,
  rsaCertificate: 0xdb,
  // gen2 / tokutei
  cardNumber: 0xc2,
  addressImage: 0xdfd1,
  outsideComprehensive: 0xd5,
  outsideComprehensiveUntil: 0xd6,
  outsideIndividual: 0xd7,
  renewalStatus: 0xd8,
  recordedByCommissioner: 0xd9,
  reserved: 0xde,
  ecdsaCheckCode: 0xdc,
  ecdsaCertificate: 0xdd,
} as const;

/** 署名対象の最大データ長 */
export const LEGACY_FRONT_IMAGE_LEN = 7000;
export const FACE_LEN = 3000;
export const GEN2_NAME_IMAGE_LEN = 2500;

/**
 * 第2世代・特定の券面記載事項(DF1/EF02)。表の記載順 = 署名対象の連結順。
 * residenceOnly は特別永住者証明書には無い項目。
 */
export const GEN2_FACE_ITEMS = [
  { tag: 0xc5, key: "cardValidUntil", len: 8, residenceOnly: false }, // 有効期限満了日
  { tag: 0xc6, key: "birthDate", len: 8, residenceOnly: false },
  { tag: 0xc7, key: "sex", len: 1, residenceOnly: false },
  { tag: 0xc8, key: "nationality", len: 3, residenceOnly: false },
  { tag: 0xc9, key: "statusOfResidence", len: 10, residenceOnly: false },
  { tag: 0xce, key: "periodOfStay", len: 4, residenceOnly: false },
  { tag: 0xca, key: "permissionType", len: 2, residenceOnly: true },
  { tag: 0xcb, key: "permittedAt", len: 8, residenceOnly: true },
  { tag: 0xcc, key: "workRestriction", len: 1, residenceOnly: true },
  { tag: 0xcd, key: "stayExpiry", len: 8, residenceOnly: true },
] as const;

/** 券面記載事項の署名対象長(特別永住者証明書は 34 バイト + 0x00 で 53 バイトに揃える) */
export const GEN2_FACE_ITEMS_SIGNED_LEN = 53;
