/**
 * セッション鍵の確立。
 * - legacy / gen2: GET CHALLENGE + MUTUAL AUTHENTICATE(在留カード等番号から Kenc/Kmac を導出)
 * - tokutei      : SET SESSION KEY(端末生成の鍵を RSA-OAEP で配送鍵により暗号化して送る)
 */
import { concatBytes, equalBytes, xorBytes } from "./bytes.js";
import { aesCbcDecrypt, aesCbcEncrypt, aesCmac8 } from "./crypto/aes.js";
import { retailMac, tdesCbcDecrypt, tdesCbcEncrypt } from "./crypto/des.js";
import { sha1 } from "./crypto/hash.js";
import { rsaOaepSha256Encrypt, type RsaPublicKey } from "./crypto/rsaOaep.js";

export type MutualAuthFormat = "legacy" | "gen2";

/** Kenc = Kmac = SHA-1(在留カード等番号 12 バイト) の先頭 16 バイト */
export function deriveBasicKey(cardNumber: string): Uint8Array {
  if (!/^[A-Z0-9]{12}$/.test(cardNumber)) throw new Error("在留カード等番号の形式が不正です");
  return sha1(new TextEncoder().encode(cardNumber)).subarray(0, 16);
}

interface Primitives {
  enc(key: Uint8Array, data: Uint8Array): Uint8Array;
  dec(key: Uint8Array, data: Uint8Array): Uint8Array;
  mac(key: Uint8Array, data: Uint8Array): Uint8Array;
}

const PRIMITIVES: Record<MutualAuthFormat, Primitives> = {
  legacy: { enc: tdesCbcEncrypt, dec: tdesCbcDecrypt, mac: retailMac },
  gen2: { enc: aesCbcEncrypt, dec: aesCbcDecrypt, mac: aesCmac8 },
};

export interface MutualAuthInput {
  format: MutualAuthFormat;
  cardNumber: string;
  /** GET CHALLENGE で得たカード乱数(8) */
  rndIcc: Uint8Array;
  /** 端末乱数(8) */
  rndIfd: Uint8Array;
  /** セッション鍵生成用端末乱数(16) */
  kIfd: Uint8Array;
}

/** MUTUAL AUTHENTICATE のコマンドデータ E_IFD(32)||M_IFD(8) を作る */
export function buildMutualAuthData(input: MutualAuthInput): Uint8Array {
  const p = PRIMITIVES[input.format];
  const k = deriveBasicKey(input.cardNumber);
  const eIfd = p.enc(k, concatBytes(input.rndIfd, input.rndIcc, input.kIfd));
  return concatBytes(eIfd, p.mac(k, eIfd));
}

export class MutualAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutualAuthError";
  }
}

/** MUTUAL AUTHENTICATE のレスポンス E_ICC||M_ICC を検証し、セッション鍵 KSenc を返す */
export function completeMutualAuth(input: MutualAuthInput, response: Uint8Array): Uint8Array {
  if (response.length !== 40) throw new MutualAuthError("レスポンス長が不正です");
  const p = PRIMITIVES[input.format];
  const k = deriveBasicKey(input.cardNumber);
  const eIcc = response.subarray(0, 32);
  const mIcc = response.subarray(32, 40);
  if (!equalBytes(p.mac(k, eIcc), mIcc)) throw new MutualAuthError("カード認証 MAC が一致しません");
  const plain = p.dec(k, eIcc);
  if (!equalBytes(plain.subarray(0, 8), input.rndIcc) || !equalBytes(plain.subarray(8, 16), input.rndIfd)) {
    throw new MutualAuthError("乱数が一致しません");
  }
  const kIcc = plain.subarray(16, 32);
  return deriveSessionKey(input.kIfd, kIcc);
}

/** KSenc = SHA-1(K.IFD xor K.ICC || 00000001) の先頭 16 バイト */
export function deriveSessionKey(kIfd: Uint8Array, kIcc: Uint8Array): Uint8Array {
  return sha1(concatBytes(xorBytes(kIfd, kIcc), Uint8Array.of(0, 0, 0, 1))).subarray(0, 16);
}

export interface SetSessionKeyInput {
  /** カードの配送鍵(公開鍵)。仕様書に値の記載なし(SPEC_NOTES.md の未解決事項) */
  deliveryKey: RsaPublicKey;
  /** 暗号化用セッション鍵(16)。SM ではこれを KSenc として使う */
  kEnc: Uint8Array;
  /** CCS 用セッション鍵(16) */
  kMac: Uint8Array;
  /** Seed1(16)。鍵の元データ 32 バイト = 鍵(16)||Seed1(16) */
  seed1: Uint8Array;
  /** OAEP の seed(32) */
  oaepSeed: Uint8Array;
}

/** SET SESSION KEY のデータ部(RSA-OAEP 暗号文 256 バイト) */
export function buildSetSessionKeyData(input: SetSessionKeyInput): Uint8Array {
  if (input.kEnc.length !== 16 || input.kMac.length !== 16 || input.seed1.length !== 16) {
    throw new Error("鍵・Seed の長さが不正です");
  }
  const message = concatBytes(
    Uint8Array.of(0xa0, 0x44, 0x80, 0x20),
    input.kEnc,
    input.seed1,
    Uint8Array.of(0x81, 0x20),
    input.kMac,
    input.seed1,
  );
  return rsaOaepSha256Encrypt(input.deliveryKey, message, input.oaepSeed);
}
