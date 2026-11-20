/**
 * 撮影画像の処理。カメラロールには保存しない。一時ファイルは処理後すぐ消す(CLAUDE.md ルール4)
 */
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { extractCardNumberCandidates } from "@zairyu/shared";
import { File } from "expo-file-system";
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
