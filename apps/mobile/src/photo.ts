/**
 * 撮影画像の処理。カメラロールには保存しない。一時ファイルは処理後すぐ消す(CLAUDE.md ルール4)
 */
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { extractCardNumberCandidates, frontFieldsFromOcr, latestAddressFromBackOcr, type FrontOcrFields, type OcrLine } from "@zairyu/shared";
import { File, Paths } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

export const toFileUrl = (path: string) => (path.startsWith("file://") ? path : `file://${path}`);

export function deleteFile(pathOrUrl: string): void {
  try {
    const f = new File(toFileUrl(pathOrUrl));
    if (f.exists) f.delete();
  } catch {
    // 削除に失敗してもアプリは止めない(一時ディレクトリは OS が掃除する)
  }
}

/** 端末内 OCR で番号の候補を取り出す(画像は外部に送らない。CLAUDE.md ルール3) */
export async function recognizeCardNumber(pathOrUrl: string): Promise<string[]> {
  const result = await TextRecognition.recognize(toFileUrl(pathOrUrl), TextRecognitionScript.LATIN);
  return extractCardNumberCandidates(result.blocks.flatMap((b) => b.lines.map((l) => l.text)).join("\n"));
}

/** 日本語の認識(住居地・在留資格など)。行の位置(上端)も返す */
async function japaneseLines(pathOrUrl: string): Promise<OcrLine[]> {
  const result = await TextRecognition.recognize(toFileUrl(pathOrUrl), TextRecognitionScript.JAPANESE);
  return result.blocks.flatMap((b) => b.lines.map((l) => ({ text: l.text, top: l.frame?.top, left: l.frame?.left, height: l.frame?.height })));
}

/**
 * 表面の端末内 OCR: 番号の候補(英数字の認識)と、記載事項の候補(日本語の認識)。
 * 全文は保持せず、取り出した候補だけを返す
 */
export async function recognizeFront(pathOrUrl: string): Promise<{ numbers: string[]; fields: FrontOcrFields | null }> {
  const numbers = await recognizeCardNumber(pathOrUrl).catch(() => []);
  const fields = await japaneseLines(pathOrUrl)
    .then(frontFieldsFromOcr)
    .catch(() => null);
  return { numbers, fields };
}

/** 裏面の端末内 OCR: 住居地記載欄のいちばん新しい記載 */
export async function recognizeBackAddress(pathOrUrl: string): Promise<string | null> {
  return japaneseLines(pathOrUrl)
    .then(latestAddressFromBackOcr)
    .catch(() => null);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 枠の外側に残す余白(枠の幅・高さに対する割合)。合わせ方のずれでカードの端が切れないようにする */
const GUIDE_MARGIN = 0.06;

/**
 * 撮影した写真を、画面の枠(カードの位置)の範囲で切り抜く。新しい一時ファイルのパスを返す(呼び出し側が消す)。
 * プレビューは画面いっぱいに「はみ出して表示」(cover)されている前提で、画面の座標を写真の座標に直す。
 * 向きが画面と合わないなど、正しく切り抜けないときは null(元の写真をそのまま使う)
 */
export async function cropToGuide(pathOrUrl: string, view: { width: number; height: number }, guide: Rect): Promise<string | null> {
  if (!view.width || !view.height || !guide.width || !guide.height) return null;
  // 向き(EXIF)を反映した画像にしてから寸法を見る
  const upright = await manipulateAsync(toFileUrl(pathOrUrl), [], { compress: 1, format: SaveFormat.JPEG });
  try {
    const { width: pw, height: ph } = upright;
    if (!pw || !ph || pw > ph !== view.width > view.height) return null;
    const scale = Math.max(view.width / pw, view.height / ph);
    const offX = (pw * scale - view.width) / 2;
    const offY = (ph * scale - view.height) / 2;
    const mx = guide.width * GUIDE_MARGIN;
    const my = guide.height * GUIDE_MARGIN;
    const left = Math.max(0, Math.floor((guide.x - mx + offX) / scale));
    const top = Math.max(0, Math.floor((guide.y - my + offY) / scale));
    const right = Math.min(pw, Math.ceil((guide.x + guide.width + mx + offX) / scale));
    const bottom = Math.min(ph, Math.ceil((guide.y + guide.height + my + offY) / scale));
    if (right - left < pw * 0.3 || bottom - top < ph * 0.1) return null;
    const cropped = await manipulateAsync(upright.uri, [{ crop: { originX: left, originY: top, width: right - left, height: bottom - top } }], {
      compress: 0.95,
      format: SaveFormat.JPEG,
    });
    return cropped.uri;
  } finally {
    deleteFile(upright.uri);
  }
}

/** 送信用に縮小した JPEG(base64)。長辺 1600px・品質 0.7(数百 KB 程度) */
export async function compressForUpload(pathOrUrl: string): Promise<{ contentType: "image/jpeg"; data: string }> {
  const r = await manipulateAsync(toFileUrl(pathOrUrl), [{ resize: { width: 1600 } }], {
    compress: 0.7,
    format: SaveFormat.JPEG,
    base64: true,
  });
  deleteFile(r.uri);
  if (!r.base64) throw new Error("画像を変換できませんでした");
  return { contentType: "image/jpeg", data: r.base64 };
}

/**
 * 保存済みの撮影画像(サーバーから受け取った base64)を端末内 OCR にかける。
 * ML Kit はファイルから読むため一時ファイルに書き、読み取り後すぐに消す(カメラロールには保存しない)
 */
export async function recognizeSavedImage<T>(base64: string, recognize: (path: string) => Promise<T>): Promise<T> {
  const file = new File(Paths.cache, `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    file.create();
    file.write(base64, { encoding: "base64" });
    return await recognize(file.uri);
  } finally {
    deleteFile(file.uri);
  }
}
