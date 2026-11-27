/**
 * カード画像の表示用変換(サーバー内のみ。外部サービスには送らない)。
 * - IC の券面・氏名・住居地イメージ: MMR(CCITT G4)圧縮の TIFF → PNG(sharp / libvips)
 * - IC の顔画像: JPEG2000 → JPEG(OpenJPEG の WebAssembly 版で画素に戻し、sharp で圧縮)
 * - 撮影画像(JPEG / PNG): そのまま
 * 元の画像は暗号化して保管したまま、表示のたびに変換する
 */
import { createRequire } from "node:module";
import sharp from "sharp";

export interface DisplayImage {
  contentType: "image/png" | "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
}

export class ImageConvertError extends Error {
  constructor(
    readonly sourceType: string,
    /** 先頭 8 バイト(ファイル形式の判別用。画像の中身は含まない) */
    readonly signature: string,
  ) {
    super(`画像を表示用に変換できませんでした(${sourceType}、先頭 ${signature})`);
    this.name = "ImageConvertError";
  }
}

interface J2KDecoder {
  getEncodedBuffer(length: number): Uint8Array;
  decode(): void;
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean };
  getDecodedBuffer(): Uint8Array;
  delete(): void;
}

let openjpeg: Promise<{ J2KDecoder: new () => J2KDecoder }> | null = null;

function loadOpenJpeg() {
  const require = createRequire(import.meta.url);
  const factory = require("@cornerstonejs/codec-openjpeg/decodewasmjs") as (opts: object) => Promise<{ J2KDecoder: new () => J2KDecoder }>;
  // ライブラリのログ出力は捨てる
  openjpeg ??= factory({ print: () => {}, printErr: () => {} });
  return openjpeg;
}

async function jpeg2000ToJpeg(data: Uint8Array): Promise<DisplayImage> {
  const { J2KDecoder } = await loadOpenJpeg();
  const dec = new J2KDecoder();
  try {
    dec.getEncodedBuffer(data.length).set(data);
    dec.decode();
    const fi = dec.getFrameInfo();
    const src = dec.getDecodedBuffer();
    const pixels = fi.width * fi.height * fi.componentCount;
    let rgb: Buffer;
    if (fi.bitsPerSample > 8) {
      // 16 ビットの画素を 8 ビットに落とす
      const u16 = new Uint16Array(src.buffer, src.byteOffset, pixels);
      rgb = Buffer.alloc(pixels);
      const shift = fi.bitsPerSample - 8;
      for (let i = 0; i < pixels; i++) rgb[i] = u16[i]! >> shift;
    } else {
      rgb = Buffer.from(src.subarray(0, pixels));
    }
    const channels = fi.componentCount === 1 ? 1 : 3;
    const out = await sharp(rgb, { raw: { width: fi.width, height: fi.height, channels: channels as 1 | 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { contentType: "image/jpeg", data: out, width: fi.width, height: fi.height };
  } finally {
    dec.delete();
  }
}

export async function toDisplayImage(contentType: string, data: Uint8Array): Promise<DisplayImage> {
  try {
    if (contentType === "image/jp2") return await jpeg2000ToJpeg(data);
    if (contentType === "image/tiff") {
      // 白黒 2 値の文字画像。白を透明にした PNG にして、背景や顔写真と重ねられるようにする
      // (白い背景の上にそのまま置けば従来どおりの見た目になる)
      const { data: grey, info } = await sharp(data).greyscale().raw().toBuffer({ resolveWithObject: true });
      const rgba = Buffer.alloc(info.width * info.height * 4);
      for (let i = 0; i < info.width * info.height; i++) {
        rgba[i * 4 + 3] = 255 - grey[i * info.channels]!; // 黒いほど不透明
      }
      const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
      return { contentType: "image/png", data: png, width: info.width, height: info.height };
    }
    if (contentType === "image/jpeg" || contentType === "image/png") {
      const meta = await sharp(data).metadata();
      return { contentType, data: Buffer.from(data), width: meta.width ?? 0, height: meta.height ?? 0 };
    }
  } catch {
    // 変換の失敗理由(ライブラリのメッセージ)は返さない
  }
  throw new ImageConvertError(contentType, Buffer.from(data.subarray(0, 8)).toString("hex").toUpperCase());
}

/**
 * 端末内 OCR 用の画像(第2世代の IC の住居地イメージなど、白黒の文字画像)。
 * 白い背景に黒い文字の PNG にし、小さい文字が読めるよう 3 倍に拡大して余白を付ける。外部には送らない
 */
export async function toOcrImage(contentType: string, data: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    {
      // TIFF 以外(想定外の形式)でも sharp で開ければ使う
      const meta = await sharp(data).metadata();
      const w = meta.width ?? 0;
      if (!w) throw new Error("size");
      const out = await sharp(data)
        .flatten({ background: "#ffffff" })
        .greyscale()
        .resize({ width: w * 3, kernel: "cubic" })
        .extend({ top: 24, bottom: 24, left: 24, right: 24, background: "#ffffff" })
        .png()
        .toBuffer({ resolveWithObject: true });
      return { data: out.data, width: out.info.width, height: out.info.height };
    }
  } catch {
    // 変換の失敗理由は返さない
  }
  throw new ImageConvertError(contentType, Buffer.from(data.subarray(0, 8)).toString("hex").toUpperCase());
}
