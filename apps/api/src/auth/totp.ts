/** TOTP(RFC 6238: HMAC-SHA1、30 秒、6 桁)。Google Authenticator 等の認証アプリと互換 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PERIOD_SEC = 30;
const DIGITS = 6;
/** 時計のずれを許容するステップ数(前後 1 = ±30 秒) */
const WINDOW = 1;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32 として不正な文字です");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新しい秘密鍵(160 ビット) */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SEC);
}

/** 指定ステップのコード(digits 桁) */
export function totpCode(secret: Uint8Array, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

/**
 * コードを検証し、一致したステップを返す。lastStep 以下のステップは再利用として拒否する
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = current + d;
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secret: Uint8Array, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(PERIOD_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
