/**
 * RSA-OAEP(PKCS#1 v2.2、SHA-256、MGF1-SHA-256、ラベル空)の暗号化。
 * 特定在留カードの SET SESSION KEY 用。端末で動かすため BigInt で実装する。
 */
import { concatBytes, xorBytes } from "../bytes.js";
import { sha256 } from "./hash.js";

export interface RsaPublicKey {
  /** 法 n(big-endian) */
  modulus: Uint8Array;
  /** 公開指数 e(big-endian) */
  exponent: Uint8Array;
}

const H_LEN = 32;

function toBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}

function toBytes(x: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("値が長さに収まりません");
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

export function mgf1Sha256(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let counter = 0, offset = 0; offset < length; counter++, offset += H_LEN) {
    const c = Uint8Array.of(counter >>> 24, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff);
    const h = sha256(concatBytes(seed, c));
    out.set(h.subarray(0, Math.min(H_LEN, length - offset)), offset);
  }
  return out;
}

/** OAEP エンコード済みブロック EM(k バイト)を作る */
export function oaepEncode(message: Uint8Array, k: number, seed: Uint8Array): Uint8Array {
  if (seed.length !== H_LEN) throw new Error("OAEP seed は 32 バイトです");
  const psLen = k - message.length - 2 * H_LEN - 2;
  if (psLen < 0) throw new Error("メッセージが長すぎます");
  const lHash = sha256(new Uint8Array(0));
  const db = concatBytes(lHash, new Uint8Array(psLen), Uint8Array.of(1), message);
  const maskedDb = xorBytes(db, mgf1Sha256(seed, db.length));
  const maskedSeed = xorBytes(seed, mgf1Sha256(maskedDb, H_LEN));
  return concatBytes(Uint8Array.of(0), maskedSeed, maskedDb);
}

export function rsaOaepSha256Encrypt(key: RsaPublicKey, message: Uint8Array, seed: Uint8Array): Uint8Array {
  let modBytes = key.modulus;
  while (modBytes.length > 0 && modBytes[0] === 0) modBytes = modBytes.subarray(1);
  const k = modBytes.length;
  const em = oaepEncode(message, k, seed);
  const c = modPow(toBigInt(em), toBigInt(key.exponent), toBigInt(modBytes));
  return toBytes(c, k);
}
