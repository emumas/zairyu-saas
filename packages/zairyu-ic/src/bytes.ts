/** バイト列ユーティリティ(端末・サーバー共通。Node 固有 API は使わない) */

export function hex(s: string): Uint8Array {
  const clean = s.replace(/[\s:]/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("不正な16進文字列です");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s.toUpperCase();
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error("長さが一致しません");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** 定数時間比較 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** ISO/IEC 9797-1 パディング方式2(80 00..)。常に 1 バイト以上付加する */
export function padIso(data: Uint8Array, blockSize: number): Uint8Array {
  const padLen = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

export function unpadIso(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0x00) i--;
  if (i < 0 || data[i] !== 0x80) throw new Error("パディングが不正です");
  return data.subarray(0, i);
}

/** 末尾の 0x00 埋めを取り除く */
export function trimTrailingNulls(data: Uint8Array): Uint8Array {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0x00) end--;
  return data.subarray(0, end);
}

/** 指定長まで 0x00 で埋める(長すぎる場合はエラー) */
export function padNulls(data: Uint8Array, length: number): Uint8Array {
  if (data.length > length) throw new Error(`データが最大長 ${length} を超えています`);
  const out = new Uint8Array(length);
  out.set(data);
  return out;
}

export function ascii(data: Uint8Array): string {
  let s = "";
  for (const b of trimTrailingNulls(data)) s += String.fromCharCode(b);
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 エンコード(端末でも使えるよう Buffer/btoa に依存しない) */
export function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? "=" : B64[(n >> 6) & 63]!;
    out += c === undefined ? "=" : B64[n & 63]!;
  }
  return out;
}
