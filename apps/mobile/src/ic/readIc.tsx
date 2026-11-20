/** IC の読み取り(登録ウィザードと再検証で共通) */
import type { IcReadPayload } from "@zairyu/shared";
import { CardNumberMismatchError, CardReadError, readResidenceCard, toBase64, type EfPath } from "@zairyu/zairyu-ic";
import { Vibration, View } from "react-native";
import { randomBytes, tokuteiDeliveryKey } from "../config";
import { maxReadLengthFor, withIsoDep } from "../nfc";
import { color, Message } from "../ui/kit";

export type IcProgress = { phase: "wait" | "reading" | "checking"; apdus: number } | null;

/**
 * カードを待ち受けて IC を読み、サーバーへ送る形にして返す。
 * 読み終わったら振動で知らせ(カードを離してよい)、進み具合を onProgress で伝える
 */
export async function readIcPayload(cardNumber: string, onProgress: (p: IcProgress) => void): Promise<IcReadPayload> {
  onProgress({ phase: "wait", apdus: 0 });
  const raw = await withIsoDep(async (rawTransceive, info) => {
    const maxReadLength = maxReadLengthFor(info);
    const deliveryKey = tokuteiDeliveryKey();
    let n = 0;
    const transceive = async (apdu: Uint8Array) => {
      onProgress({ phase: "reading", apdus: ++n });
      return rawTransceive(apdu);
    };
    return readResidenceCard(transceive, {
      cardNumber,
      randomBytes,
      ...(maxReadLength ? { maxReadLength } : {}),
      ...(deliveryKey ? { tokuteiDeliveryKey: deliveryKey } : {}),
    });
  });
  Vibration.vibrate(150);
  onProgress({ phase: "checking", apdus: 0 });
  const files: Partial<Record<EfPath, string>> = {};
  for (const [path, data] of Object.entries(raw.files)) if (data) files[path as EfPath] = toBase64(data);
  return { format: raw.format, kind: raw.kind, files };
}

export function icErrorMessage(e: unknown): string {
  if (e instanceof CardNumberMismatchError) return "在留カード番号が一致しません。番号を確認してください。";
  if (e instanceof CardReadError) {
    if (e.step === "mutual_authenticate") return "カードとの認証に失敗しました。番号が正しいか(別のカードでないか)確認してください。";
    if (e.step === "set_session_key") return "特定在留カードは現在読み取れません(配送鍵が未設定)。";
    return "読み取りに失敗しました。カードを端末の背面に当て、動かさずにもう一度お試しください。";
  }
  return "読み取りに失敗しました。もう一度お試しください。";
}

export const isCardReadError = (e: unknown) => e instanceof CardReadError;

export function IcProgressView({ progress }: { progress: IcProgress }) {
  if (!progress) return null;
  if (progress.phase === "wait") return <Message text="カードを端末の背面に当ててください" tone="warn" />;
  if (progress.phase === "checking") return <Message text="読み取り完了。カードを離して大丈夫です。サーバーで確認しています…" tone="ok" />;
  return (
    <View style={{ gap: 4 }}>
      <Message text="読み取り中… カードを動かさないでください" tone="warn" />
      {/* 旧様式で約 16 回、第2世代で約 20 回のやり取り */}
      <View style={{ height: 6, backgroundColor: color.muted, borderRadius: 3 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: color.primary, width: `${Math.min(95, (progress.apdus / 20) * 100)}%` }} />
      </View>
    </View>
  );
}
