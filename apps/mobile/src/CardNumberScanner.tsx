/**
 * 券面(表)を撮影し、端末内 OCR で在留カード番号を読み取るモーダル。
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, useCameraPermission, usePhotoOutput } from "react-native-vision-camera";
import { deletePhoto, recognizeCardNumber, type OcrResult } from "./ocr";

interface Props {
  visible: boolean;
  onClose: () => void;
  onResult: (result: OcrResult) => void;
  /** 撮影したが番号が見つからなかった(計測用) */
  onFailedShot?: () => void;
}

export function CardNumberScanner({ visible, onClose, onResult, onFailedShot }: Props) {
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({ qualityPrioritization: "balanced" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { hasPermission, canRequestPermission, requestPermission } = permission;
  useEffect(() => {
    if (!visible) return;
    setMessage(null);
    if (!hasPermission && canRequestPermission) {
      // 再読み込み等でネイティブ側の Promise が破棄されることがあるため、失敗は握りつぶさず表示だけにする
      requestPermission().catch(() => setMessage("カメラの許可を確認できませんでした。もう一度開いてください。"));
    }
  }, [visible, hasPermission, canRequestPermission, requestPermission]);

  async function capture() {
    setBusy(true);
    setMessage(null);
    let path: string | null = null;
    try {
      const photo = await photoOutput.capturePhotoToFile({ flashMode: "off" }, {});
      path = photo.filePath;
      const result = await recognizeCardNumber(path);
      path = null; // recognizeCardNumber が削除済み
      if (result.candidates.length === 0) {
        onFailedShot?.();
        setMessage("番号を読み取れませんでした。カードを枠に合わせ、反射を避けて撮り直してください。");
        return;
      }
      onResult(result);
    } catch {
      setMessage("撮影に失敗しました。もう一度お試しください。");
    } finally {
      if (path) deletePhoto(path);
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {hasPermission ? (
          <Camera style={StyleSheet.absoluteFill} device="back" isActive={visible} outputs={[photoOutput]} />
        ) : (
          <Text style={styles.text}>カメラの使用が許可されていません。設定アプリから許可してください。</Text>
        )}
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.guide} />
          <Text style={styles.text}>カードの表面を枠に合わせてください</Text>
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
  // 在留カードは ID-1 サイズ(85.6 x 54 mm)
  guide: { width: "88%", aspectRatio: 85.6 / 54, borderWidth: 2, borderColor: "#fff", borderRadius: 12 },
  bottom: { position: "absolute", bottom: 48, left: 24, right: 24, alignItems: "center", gap: 16 },
  shutter: { backgroundColor: "#fff", borderRadius: 40, width: 80, height: 80, alignItems: "center", justifyContent: "center" },
  shutterText: { fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  text: { color: "#fff", textAlign: "center" },
  message: { color: "#ffd7d5", textAlign: "center" },
});
