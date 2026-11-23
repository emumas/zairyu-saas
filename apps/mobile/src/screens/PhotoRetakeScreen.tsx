/**
 * 写真の撮り直し: 現在のカードの撮影画像(表面・裏面)を撮り直して差し替える。
 * - カメラロールには保存しない。一時ファイルは変換後すぐ消す(CLAUDE.md ルール4)
 * - 古い写真はサーバーで消える。IC の画像は変わらない
 */
import { useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { compressForUpload, deleteFile } from "../photo";
import { CameraCapture } from "../ui/CameraCapture";
import { CardImage } from "../ui/CardImage";
import { Button, Card, color, Message, Screen } from "../ui/kit";

type Photo = { contentType: "image/jpeg"; data: string };
type Kind = "front" | "back";
const LABEL: Record<Kind, string> = { front: "表面", back: "裏面" };

export function PhotoRetakeScreen({
  cardId,
  personName,
  onClose,
  onSaved,
  onReadDetails,
}: {
  cardId: string;
  personName: string;
  onClose: () => void;
  onSaved: () => void;
  onReadDetails: () => void;
}) {
  const [camera, setCamera] = useState<Kind | null>(null);
  const [photos, setPhotos] = useState<Partial<Record<Kind, Photo>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Kind[] | null>(null);

  async function onCaptured(path: string) {
    const kind = camera!;
    try {
      const p = await compressForUpload(path);
      setPhotos((cur) => ({ ...cur, [kind]: p }));
    } finally {
      deleteFile(path);
    }
    setCamera(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cards.replacePhotos.mutate({ cardId, ...photos });
      setPhotos({}); // 送信後は端末のメモリにも残さない
      setSaved(r.replaced);
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const count = Object.keys(photos).length;
  return (
    <Screen title={`写真の撮り直し: ${personName}`} onBack={onClose}>
      <CameraCapture visible={camera !== null} title={camera ? `${LABEL[camera]}を撮影` : ""} onClose={() => setCamera(null)} onCaptured={onCaptured} />
      {saved ? (
        <Card>
          <Text style={{ fontWeight: "700" }}>{saved.map((k) => LABEL[k]).join("・")}の写真を差し替えました</Text>
          <Text style={{ color: color.sub }}>古い写真は削除しました。新しい写真から記載事項(住居地など)を読み直すこともできます。</Text>
          <Button label="写真から記載事項を読み直す" onPress={onReadDetails} />
          <Button label="登録者の画面に戻る" kind="secondary" onPress={onClose} />
        </Card>
      ) : (
        <>
          <Card>
            <Text>ぶれや光の反射で読めない写真を撮り直します。撮り直した面だけ差し替わり、IC の記録は変わりません。写真は端末に保存しません。</Text>
          </Card>
          {(["front", "back"] as const).map((k) => (
            <Card key={k}>
              <Text style={{ fontWeight: "700" }}>{LABEL[k]}</Text>
              {photos[k] ? <CardImage kind={k} {...photos[k]} /> : <Text style={{ color: color.sub }}>撮り直さない場合は、今の写真のままです。</Text>}
              <Button label={photos[k] ? `${LABEL[k]}をもう一度撮る` : `${LABEL[k]}を撮影`} kind={photos[k] ? "secondary" : "primary"} onPress={() => setCamera(k)} />
              {photos[k] && (
                <Button
                  label="この面は撮り直さない"
                  kind="secondary"
                  onPress={() =>
                    setPhotos((cur) => {
                      const { [k]: _removed, ...rest } = cur;
                      return rest;
                    })
                  }
                />
              )}
            </Card>
          ))}
          <Message text={error} />
          <Button label={count ? `${count} 枚の写真を保存` : "写真を撮影してください"} busy={busy} disabled={count === 0} onPress={() => void save()} />
        </>
      )}
    </Screen>
  );
}
