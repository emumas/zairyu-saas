import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageConvertError, toDisplayImage } from "./imageConvert.js";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url));

describe("表示用の変換", () => {
  it("MMR(CCITT G4)の TIFF を PNG にする", async () => {
    const r = await toDisplayImage("image/tiff", fixture("g4.tif"));
    expect(r).toMatchObject({ contentType: "image/png", width: 600, height: 380 });
    expect((await sharp(r.data).metadata()).format).toBe("png");
  });

  it.each(["face8.jp2", "face16.jp2", "face.j2k"])("JPEG2000(%s)を JPEG にする", async (name) => {
    const r = await toDisplayImage("image/jp2", fixture(name));
    expect(r).toMatchObject({ contentType: "image/jpeg", width: 160, height: 200 });
    const { data } = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    // グラデーション(赤→青)の上端が赤いこと(8 ビット化の誤りで真っ黒にならないこと)
    expect(data[0]!).toBeGreaterThan(200);
  });

  it("撮影画像(JPEG)はそのまま", async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const r = await toDisplayImage("image/jpeg", jpeg);
    expect(r.data.equals(jpeg)).toBe(true);
  });

  it("壊れたデータ・未対応の形式はエラー", async () => {
    await expect(toDisplayImage("image/jp2", Buffer.from("not an image"))).rejects.toBeInstanceOf(ImageConvertError);
    await expect(toDisplayImage("image/gif", Buffer.from("GIF89a"))).rejects.toBeInstanceOf(ImageConvertError);
  });
});
