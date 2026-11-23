/**
 * 撮影画像(表面・裏面)の差し替え(Web)。選んだ画像はブラウザ内で縮小して JPEG にし、サーバーへ送る(外部のサービスには送らない)。
 * 古い写真はサーバーで消える。IC の画像は変わらない
 */
import { useState } from "react";
import { api, messageOf } from "../api";
import { Button, Message } from "../ui";

type Kind = "front" | "back";
type Photo = { contentType: "image/jpeg"; data: string; preview: string; name: string };
const LABEL: Record<Kind, string> = { front: "表面", back: "裏面" };

/** 長辺 1600px まで縮小して JPEG(base64)にする。アプリの撮影と同じ大きさにそろえる */
async function toJpeg(file: File): Promise<Photo> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) throw new Error("JPEG・PNG の画像を選んでください");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("画像を読み込めませんでした(JPEG・PNG を選んでください)");
  });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const preview = canvas.toDataURL("image/jpeg", 0.75);
  return { contentType: "image/jpeg", data: preview.slice(preview.indexOf(",") + 1), preview, name: file.name };
}

export function PhotoReplaceForm({ cardId, onDone }: { cardId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<Partial<Record<Kind, Photo>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(kind: Kind, file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const p = await toJpeg(file);
      setPhotos((cur) => ({ ...cur, [kind]: p }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.cards.replacePhotos.mutate({
        cardId,
        ...(photos.front ? { front: { contentType: photos.front.contentType, data: photos.front.data } } : {}),
        ...(photos.back ? { back: { contentType: photos.back.contentType, data: photos.back.data } } : {}),
      });
      setPhotos({});
      setOpen(false);
      onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button kind="secondary" onClick={() => setOpen(true)}>
        写真を差し替える
      </Button>
    );
  }
  const count = Object.keys(photos).length;
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <p className="sub">ぶれや反射で読めない写真を差し替えます。選んだ面だけ差し替わり、古い写真は削除されます(IC の記録は変わりません)。スマホアプリの「写真を撮り直す」でも差し替えられます。</p>
      <div className="row wrap">
        {(["front", "back"] as const).map((k) => (
          <div key={k} style={{ minWidth: 240 }}>
            <strong>{LABEL[k]}</strong>
            {photos[k] && <img src={photos[k]!.preview} alt={`新しい${LABEL[k]}`} style={{ display: "block", width: 240, border: "1px solid #ccc", margin: "4px 0" }} />}
            <label className="btn btn-secondary">
              {photos[k] ? "選び直す" : `${LABEL[k]}の画像を選ぶ`}
              <input
                type="file"
                accept="image/jpeg,image/png"
                hidden
                onChange={(e) => {
                  void pick(k, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        ))}
      </div>
      <Message text={error} />
      <div className="row">
        <Button
          kind="secondary"
          onClick={() => {
            setPhotos({});
            setOpen(false);
          }}
        >
          やめる
        </Button>
        <Button busy={busy} disabled={count === 0} onClick={() => void save()}>
          {count ? `${count} 枚を差し替える` : "画像を選んでください"}
        </Button>
      </div>
    </div>
  );
}
