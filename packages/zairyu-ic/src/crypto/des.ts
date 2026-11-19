/**
 * DES / 2-key TDES(EDE)と Retail MAC(ISO/IEC 9797-1 MAC Algorithm 3)。
 * 旧様式在留カードのセキュアメッセージング用。端末(React Native)で動かすため純 TS で実装する。
 * 端末(Hermes)での速度のため、置換と S-box は起動時に表へ展開してから 32 ビット演算で処理する。
 */
import { padIso } from "../bytes.js";

// prettier-ignore
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
// prettier-ignore
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
// prettier-ignore
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
// prettier-ignore
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
// prettier-ignore
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
// prettier-ignore
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

type Bits = Uint8Array; // 1 要素 = 1 ビット(鍵スケジュールと表の生成でのみ使う)

function toBits(bytes: Uint8Array): Bits {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
  return out;
}

function permute(bits: Bits, table: readonly number[]): Bits {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i]! - 1]!;
  return out;
}

function rotl28(bits: Bits, n: number): Bits {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[(i + n) % bits.length]!;
  return out;
}

/** 64 ビット置換をバイト単位の表引き(8 x 256 x 2 ワード)に展開する */
function buildPermTable(table: readonly number[]): Uint32Array {
  const t = new Uint32Array(8 * 256 * 2);
  for (let pos = 0; pos < 8; pos++) {
    for (let v = 0; v < 256; v++) {
      let hi = 0;
      let lo = 0;
      for (let i = 0; i < 64; i++) {
        const src = table[i]! - 1;
        if ((src >> 3) !== pos) continue;
        if ((v >> (7 - (src & 7))) & 1) {
          if (i < 32) hi |= 1 << (31 - i);
          else lo |= 1 << (63 - i);
        }
      }
      t[(pos * 256 + v) * 2] = hi >>> 0;
      t[(pos * 256 + v) * 2 + 1] = lo >>> 0;
    }
  }
  return t;
}

/** S-box の出力に P 置換まで適用した表(8 x 64) */
function buildSpTable(): Uint32Array {
  const t = new Uint32Array(8 * 64);
  for (let s = 0; s < 8; s++) {
    for (let v = 0; v < 64; v++) {
      const row = ((v >> 4) & 2) | (v & 1);
      const col = (v >> 1) & 15;
      const out = S[s]![row * 16 + col]!;
      let word = 0;
      for (let j = 0; j < 4; j++) {
        if ((out >> (3 - j)) & 1) {
          const bitPos = s * 4 + j + 1; // P 置換前の位置(1 始まり)
          const dst = P.indexOf(bitPos); // P 置換後の位置(0 始まり)
          word |= 1 << (31 - dst);
        }
      }
      t[s * 64 + v] = word >>> 0;
    }
  }
  return t;
}

const IP_T = buildPermTable(IP);
const FP_T = buildPermTable(FP);
const SP = buildSpTable();

function perm64(t: Uint32Array, hi: number, lo: number): [number, number] {
  let oh = 0;
  let ol = 0;
  const bytes = [hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255];
  for (let pos = 0; pos < 8; pos++) {
    const i = (pos * 256 + bytes[pos]!) * 2;
    oh |= t[i]!;
    ol |= t[i + 1]!;
  }
  return [oh >>> 0, ol >>> 0];
}

/** 鍵スケジュール: 16 ラウンド x 8 個の 6 ビット値 */
function subkeys(key: Uint8Array): Uint8Array {
  if (key.length !== 8) throw new Error("DES 鍵は 8 バイトです");
  const k = permute(toBits(key), PC1);
  let c = k.subarray(0, 28) as Bits;
  let d = k.subarray(28) as Bits;
  const out = new Uint8Array(16 * 8);
  SHIFTS.forEach((shift, round) => {
    c = rotl28(c, shift);
    d = rotl28(d, shift);
    const cd = new Uint8Array(56);
    cd.set(c);
    cd.set(d, 28);
    const k48 = permute(cd, PC2);
    for (let s = 0; s < 8; s++) {
      let v = 0;
      for (let j = 0; j < 6; j++) v = (v << 1) | k48[s * 6 + j]!;
      out[round * 8 + s] = v;
    }
  });
  return out;
}

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

function feistel(r: number, keys: Uint8Array, round: number): number {
  // E 拡張: 6 ビット組 s は R のビット 4s..4s+5(1 始まり、0 は 32 に巡回)
  let f = 0;
  for (let s = 0; s < 8; s++) {
    const chunk = (rotl(r, (4 * s + 31) % 32) >>> 26) & 63;
    f |= SP[s * 64 + (chunk ^ keys[round * 8 + s]!)]!;
  }
  return f >>> 0;
}

function desWords(hi: number, lo: number, keys: Uint8Array, decrypt: boolean): [number, number] {
  let [l, r] = perm64(IP_T, hi, lo);
  for (let i = 0; i < 16; i++) {
    const nr = (l ^ feistel(r, keys, decrypt ? 15 - i : i)) >>> 0;
    l = r;
    r = nr;
  }
  return perm64(FP_T, r, l);
}

const readU32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const writeU32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
};

function desBlock(block: Uint8Array, keys: Uint8Array, decrypt: boolean): Uint8Array {
  const [hi, lo] = desWords(readU32(block, 0), readU32(block, 4), keys, decrypt);
  const out = new Uint8Array(8);
  writeU32(out, 0, hi);
  writeU32(out, 4, lo);
  return out;
}

export class Des {
  private readonly keys: Uint8Array;
  constructor(key: Uint8Array) {
    this.keys = subkeys(key);
  }
  encryptBlock(b: Uint8Array): Uint8Array {
    return desBlock(b, this.keys, false);
  }
  decryptBlock(b: Uint8Array): Uint8Array {
    return desBlock(b, this.keys, true);
  }
}

/** 2-key TDES(K1-K2-K1 の EDE) */
export class Tdes2 {
  private readonly k1: Des;
  private readonly k2: Des;
  constructor(key: Uint8Array) {
    if (key.length !== 16) throw new Error("2-key TDES 鍵は 16 バイトです");
    this.k1 = new Des(key.subarray(0, 8));
    this.k2 = new Des(key.subarray(8, 16));
  }
  encryptBlock(b: Uint8Array): Uint8Array {
    return this.k1.encryptBlock(this.k2.decryptBlock(this.k1.encryptBlock(b)));
  }
  decryptBlock(b: Uint8Array): Uint8Array {
    return this.k1.decryptBlock(this.k2.encryptBlock(this.k1.decryptBlock(b)));
  }
}

function checkBlocks(data: Uint8Array): void {
  if (data.length % 8 !== 0) throw new Error("データ長が 8 の倍数ではありません");
}

/** 2-key TDES CBC 暗号化(パディングなし、IV 既定 0) */
export function tdesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array = new Uint8Array(8)): Uint8Array {
  checkBlocks(data);
  const c = new Tdes2(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv;
  for (let i = 0; i < data.length; i += 8) {
    const x = new Uint8Array(8);
    for (let j = 0; j < 8; j++) x[j] = data[i + j]! ^ prev[j]!;
    prev = c.encryptBlock(x);
    out.set(prev, i);
  }
  return out;
}

/** 2-key TDES CBC 復号(パディング除去なし、IV 既定 0) */
export function tdesCbcDecrypt(key: Uint8Array, data: Uint8Array, iv: Uint8Array = new Uint8Array(8)): Uint8Array {
  checkBlocks(data);
  const c = new Tdes2(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv;
  for (let i = 0; i < data.length; i += 8) {
    const block = data.subarray(i, i + 8);
    const x = c.decryptBlock(block);
    for (let j = 0; j < 8; j++) out[i + j] = x[j]! ^ prev[j]!;
    prev = block;
  }
  return out;
}

/**
 * Retail MAC(ISO/IEC 9797-1 MAC Algorithm 3、パディング方式2)。
 * key = K1(8)||K2(8)。単 DES(K1) の CBC-MAC の最終ブロックを K2 で復号、K1 で暗号化する。
 */
export function retailMac(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("Retail MAC 鍵は 16 バイトです");
  const k1 = new Des(key.subarray(0, 8));
  const k2 = new Des(key.subarray(8, 16));
  const padded = padIso(data, 8);
  let h: Uint8Array = new Uint8Array(8);
  for (let i = 0; i < padded.length; i += 8) {
    const x = new Uint8Array(8);
    for (let j = 0; j < 8; j++) x[j] = padded[i + j]! ^ h[j]!;
    h = k1.encryptBlock(x);
  }
  return k1.encryptBlock(k2.decryptBlock(h));
}
