/**
 * BER-TLV パーサー(ISO/IEC 7816-4 / ASN.1 BER の確定長形式)。
 * 端末(React Native)でも動くよう Node 固有 API は使わない。
 */

export interface Tlv {
  /** タグ(複数バイトタグは big-endian で連結した値。例: 0x5F1F) */
  tag: number;
  /** 構造化(constructed)タグか */
  constructed: boolean;
  /** 値部(元バッファの部分ビュー) */
  value: Uint8Array;
  /** TLV 全体(タグ+長さ+値)の元バッファ上の範囲 */
  offset: number;
  end: number;
  /** recursive 指定時、構造化タグの子要素 */
  children?: Tlv[];
}

export class TlvError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (offset ${offset})`);
    this.name = "TlvError";
  }
}

export interface ParseOptions {
  /** 構造化タグの値を再帰的にパースする(既定 false) */
  recursive?: boolean;
  /** TLV 間の 0x00 / 0xFF パディングを読み飛ばす(ISO 7816-4。既定 true) */
  skipPadding?: boolean;
}

const MAX_TAG_BYTES = 3;
const MAX_LENGTH_BYTES = 4;

export function parseTlv(bytes: Uint8Array, options: ParseOptions = {}): Tlv[] {
  return parseRange(bytes, 0, bytes.length, options);
}

function parseRange(bytes: Uint8Array, start: number, end: number, options: ParseOptions): Tlv[] {
  const skipPadding = options.skipPadding ?? true;
  const result: Tlv[] = [];
  let pos = start;
  while (pos < end) {
    const first = bytes[pos]!;
    if (skipPadding && (first === 0x00 || first === 0xff)) {
      pos++;
      continue;
    }
    const tlvStart = pos;

    // タグ
    let tag = first;
    pos++;
    if ((first & 0x1f) === 0x1f) {
      let count = 1;
      for (;;) {
        if (pos >= end) throw new TlvError("タグが途中で終わっています", tlvStart);
        const b = bytes[pos++]!;
        tag = tag * 256 + b;
        count++;
        if (count > MAX_TAG_BYTES) throw new TlvError("タグが長すぎます", tlvStart);
        if ((b & 0x80) === 0) break;
      }
    }
    const constructed = (first & 0x20) !== 0;

    // 長さ
    if (pos >= end) throw new TlvError("長さがありません", tlvStart);
    const lenByte = bytes[pos++]!;
    let length: number;
    if (lenByte < 0x80) {
      length = lenByte;
    } else if (lenByte === 0x80) {
      throw new TlvError("不定長形式には対応していません", tlvStart);
    } else {
      const n = lenByte & 0x7f;
      if (n > MAX_LENGTH_BYTES) throw new TlvError("長さフィールドが長すぎます", tlvStart);
      if (pos + n > end) throw new TlvError("長さが途中で終わっています", tlvStart);
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + bytes[pos++]!;
    }

    // 値
    if (pos + length > end) throw new TlvError("値の長さがデータを超えています", tlvStart);
    const tlv: Tlv = {
      tag,
      constructed,
      value: bytes.subarray(pos, pos + length),
      offset: tlvStart,
      end: pos + length,
    };
    if (options.recursive && constructed) {
      tlv.children = parseRange(bytes, pos, pos + length, options);
    }
    result.push(tlv);
    pos += length;
  }
  return result;
}

/** 深さ優先で最初に見つかったタグを返す(recursive でパースしたものが対象) */
export function findTag(tlvs: readonly Tlv[], tag: number): Tlv | undefined {
  for (const t of tlvs) {
    if (t.tag === tag) return t;
    if (t.children) {
      const found = findTag(t.children, tag);
      if (found) return found;
    }
  }
  return undefined;
}

/** テスト・送信用に TLV をエンコードする(確定長・最短形式) */
export function encodeTlv(tag: number, value: Uint8Array): Uint8Array {
  const tagBytes: number[] = [];
  for (let t = tag; t > 0 || tagBytes.length === 0; t = Math.floor(t / 256)) tagBytes.unshift(t & 0xff);
  const len = value.length;
  const lenBytes: number[] = [];
  if (len < 0x80) lenBytes.push(len);
  else {
    const tmp: number[] = [];
    for (let l = len; l > 0; l = Math.floor(l / 256)) tmp.unshift(l & 0xff);
    lenBytes.push(0x80 | tmp.length, ...tmp);
  }
  const out = new Uint8Array(tagBytes.length + lenBytes.length + len);
  out.set(tagBytes, 0);
  out.set(lenBytes, tagBytes.length);
  out.set(value, tagBytes.length + lenBytes.length);
  return out;
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
