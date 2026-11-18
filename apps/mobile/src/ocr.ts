/**
 * 端末内 OCR(ML Kit テキスト認識、モデル同梱)で券面から在留カード番号を取り出す。
 * - 画像を外部に送らない(CLAUDE.md ルール3)
 * - 撮影した一時ファイルは認識後すぐ削除し、カメラロールには保存しない(ルール4)
 * - OCR の全文(氏名等を含む)は保持せず、番号の候補だけを返す
 */
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { extractCardNumberCandidates } from "@zairyu/shared";
import { File } from "expo-file-system";

export interface OcrResult {
  /** 形式に合う番号の候補(補正なしで一致したものが先) */
  candidates: string[];
  /** 認識にかかった時間(ms) */
  elapsedMs: number;
}

const toFileUrl = (path: string) => (path.startsWith("file://") ? path : `file://${path}`);

export async function recognizeCardNumber(photoPath: string): Promise<OcrResult> {
  const url = toFileUrl(photoPath);
  const started = Date.now();
  try {
    const result = await TextRecognition.recognize(url, TextRecognitionScript.LATIN);
    const lines = result.blocks.flatMap((b) => b.lines.map((l) => l.text));
    return { candidates: extractCardNumberCandidates(lines.join("\n")), elapsedMs: Date.now() - started };
  } finally {
    deletePhoto(url);
  }
}

export function deletePhoto(pathOrUrl: string): void {
  try {
    const f = new File(toFileUrl(pathOrUrl));
    if (f.exists) f.delete();
  } catch {
    // 削除に失敗してもアプリは止めない(一時ディレクトリは OS が掃除する)
  }
}
