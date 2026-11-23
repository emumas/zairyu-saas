/**
 * カードの撮影(全画面)。撮影した一時ファイルのパスを返す。呼び出し側が処理後に deleteFile すること。
 * 写真は画面の枠(カードの位置)の範囲で切り抜いて渡す(背景の文字を読まないので OCR が正確になり、保存する写真もカードだけになる)。
 * 切り抜けないときは撮影した写真をそのまま渡す
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View, type LayoutRectangle } from "react-native";
import { Camera, CommonResolutions, useCameraPermission, usePhotoOutput } from "react-native-vision-camera";
import { cropToGuide, deleteFile } from "../photo";

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  onCaptured: (path: string) => Promise<void>;
}

export function CameraCapture({ visible, title, onClose, onCaptured }: Props) {
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();
  // 4:3 はセンサー全体を使う(プレビューより広く写るので、枠で切り抜いてもカードが欠けない)。文字を読むので画質を優先
  const photoOutput = usePhotoOutput({ qualityPrioritization: "quality", targetResolution: CommonResolutions.UHD_4_3 });
  const viewSize = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const guideRect = useRef<LayoutRectangle | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setMessage(null);
    if (!hasPermission && canRequestPermission) {
      requestPermission().catch(() => setMessage("カメラの許可を確認できませんでした。もう一度開いてください。"));
    }
  }, [visible, hasPermission, canRequestPermission, requestPermission]);

  async function capture() {
    setBusy(true);
    setMessage(null);
    try {
      const photo = await photoOutput.capturePhotoToFile({ flashMode: "off" }, {});
      const cropped = guideRect.current ? await cropToGuide(photo.filePath, viewSize.current, guideRect.current).catch(() => null) : null;
      if (cropped) deleteFile(photo.filePath);
      await onCaptured(cropped ?? photo.filePath);
    } catch (e) {
      setMessage((e as Error).message || "撮影に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={styles.container}
        onLayout={(e) => {
          viewSize.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
        }}
      >
        {hasPermission ? (
          <Camera style={StyleSheet.absoluteFill} device="back" isActive={visible} outputs={[photoOutput]} resizeMode="cover" enableNativeTapToFocusGesture />
        ) : (
          <Text style={styles.text}>カメラの使用が許可されていません。設定アプリから許可してください。</Text>
        )}
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.title}>{title}</Text>
          <View
            style={styles.guide}
            onLayout={(e) => {
              guideRect.current = e.nativeEvent.layout;
            }}
          />
          <Text style={styles.text}>カードを枠いっぱいに合わせ、反射しないように撮影してください。{"\n"}文字がぼやけるときは、カードを押して(タップして)ピントを合わせてください。枠の中だけを保存します。</Text>
        </View>
        <View style={styles.bottom}>
          {message && <Text style={styles.message}>{message}</Text>}
          <Pressable style={[styles.shutter, busy && styles.disabled]} disabled={busy || !hasPermission} onPress={capture}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.shutterText}>撮影</Text>}
          </Pressable>
          <Pressable onPress={onClose} disabled={busy}>
            <Text style={styles.text}>閉じる</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", justifyContent: "center" },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  // 在留カードは ID-1 サイズ(85.6 x 54 mm)
  guide: { width: "88%", aspectRatio: 85.6 / 54, borderWidth: 2, borderColor: "#fff", borderRadius: 12 },
  bottom: { position: "absolute", bottom: 48, left: 24, right: 24, alignItems: "center", gap: 16 },
  shutter: { backgroundColor: "#fff", borderRadius: 40, width: 80, height: 80, alignItems: "center", justifyContent: "center" },
  shutterText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  text: { color: "#fff", textAlign: "center" },
  message: { color: "#ffd7d5", textAlign: "center" },
});
