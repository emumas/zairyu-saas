/** コマンド APDU の組み立てとレスポンスの分解(各仕様書 4章) */
import { concatBytes } from "./bytes.js";
import { parseTlv } from "./tlv.js";

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);

export const Apdu = {
  selectMf: () => Uint8Array.of(0x00, 0xa4, 0x00, 0x00, 0x02, 0x3f, 0x00),
  selectAid: (aid: Uint8Array) => concatBytes(Uint8Array.of(0x00, 0xa4, 0x04, 0x0c, aid.length), aid),
  /** 特定在留カードのみ: EF-ID による EF 選択 */
  selectEf: (efId: number) => concatBytes(Uint8Array.of(0x00, 0xa4, 0x02, 0x0c, 0x02), u16(efId)),
  getChallenge: () => Uint8Array.of(0x00, 0x84, 0x00, 0x00, 0x08),
  mutualAuthenticate: (data: Uint8Array) =>
    concatBytes(Uint8Array.of(0x00, 0x82, 0x00, 0x00, data.length), data, Uint8Array.of(0x00)),
  /** 特定在留カードのみ: SET SESSION KEY(拡張 Lc) */
  setSessionKey: (data: Uint8Array) => concatBytes(Uint8Array.of(0x80, 0xae, 0x00, 0x00, 0x00), u16(data.length), data),
  /** VERIFY(SM): 暗号化した在留カード等番号を SM 化データオブジェクト 86 で送る */
  verifySm: (encrypted: Uint8Array) =>
    concatBytes(
      Uint8Array.of(0x08, 0x20, 0x00, 0x86, encrypted.length + 3, 0x86, encrypted.length + 1, 0x01),
      encrypted,
    ),
  /** READ BINARY 平文。le=0 で全体 */
  readBinary: (p1: number, p2: number, le = 0) => concatBytes(Uint8Array.of(0x00, 0xb0, p1, p2, 0x00), u16(le)),
  /** READ BINARY SM(旧様式・第2世代) */
  readBinarySm: (p1: number, p2: number, le = 0) =>
    concatBytes(Uint8Array.of(0x08, 0xb0, p1, p2, 0x00, 0x00, 0x04, 0x96, 0x02), u16(le), Uint8Array.of(0x00, 0x00)),
  /** READ BINARY SM(特定在留カード。SM 化 Le オブジェクトが 96 03 00 XX XX) */
  readBinarySmTokutei: (offset: number, le: number) =>
    concatBytes(
      Uint8Array.of(0x08, 0xb0),
      u16(offset & 0x7fff),
      Uint8Array.of(0x00, 0x00, 0x05, 0x96, 0x03, 0x00),
      u16(le),
      Uint8Array.of(0x00, 0x00),
    ),
};

export interface ResponseApdu {
  data: Uint8Array;
  sw: number;
}

export function splitResponse(raw: Uint8Array): ResponseApdu {
  if (raw.length < 2) throw new Error("レスポンスが短すぎます");
  return { data: raw.subarray(0, raw.length - 2), sw: (raw[raw.length - 2]! << 8) | raw[raw.length - 1]! };
}

/** SM レスポンスのデータ部(86 L 01||暗号文)から暗号文を取り出す */
export function unwrapSmData(data: Uint8Array): Uint8Array {
  const tlv = parseTlv(data, { skipPadding: false }).find((t) => t.tag === 0x86);
  if (!tlv || tlv.value[0] !== 0x01) throw new Error("SM 化データオブジェクトが不正です");
  return tlv.value.subarray(1);
}

/** カードを扱う上での代表的なステータスワード */
export const SW = {
  OK: 0x9000,
  VERIFY_FAILED: 0x6300,
  SECURITY_NOT_SATISFIED: 0x6982,
  FILE_NOT_FOUND: 0x6a82,
} as const;
