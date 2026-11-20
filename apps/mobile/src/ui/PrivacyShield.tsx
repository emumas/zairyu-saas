/**
 * 端末保護(1-20、CLAUDE.md ルール4)
 * - スクリーンショット・画面録画を禁止(Android は FLAG_SECURE。最近使ったアプリの一覧のサムネイルも黒くなる)
 * - iOS のアプリ切り替え画面ではぼかす
 * - アプリが前面でなくなったら(切り替え画面の撮影時を含む)画面全体を無地で覆う
 * 開発用ビルドに限り EXPO_PUBLIC_ALLOW_SCREENSHOTS=1 で無効にできる(画面を共有して確認するため)
 */
import { requireOptionalNativeModule } from "expo";
import { useEffect, useState, type ReactNode } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";

const allowScreenshots = __DEV__ && process.env.EXPO_PUBLIC_ALLOW_SCREENSHOTS === "1";

/**
 * アプリ本体(ネイティブ部分)を作り直す前の開発用ビルドでは、モジュールが無く読み込みで例外になる。
 * その場合も画面全体の目隠しは働くよう、読み込みに失敗したら撮影禁止だけを諦める
 */
function loadScreenCapture(): typeof import("expo-screen-capture") | null {
  // 先にネイティブ側の有無を確かめる(無いまま require すると開発用ビルドでは赤いエラー画面になる)
  if (!requireOptionalNativeModule("ExpoScreenCapture")) {
    if (__DEV__) console.warn("expo-screen-capture が見つかりません。pnpm android でアプリを作り直してください"); // eslint-disable-line no-console
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 読み込みの失敗を捕まえるため
    return require("expo-screen-capture") as typeof import("expo-screen-capture");
  } catch {
    if (__DEV__) console.warn("expo-screen-capture が見つかりません。pnpm android でアプリを作り直してください"); // eslint-disable-line no-console
    return null;
  }
}

export function PrivacyShield({ children }: { children: ReactNode }) {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    const ScreenCapture = allowScreenshots ? null : loadScreenCapture();
    if (ScreenCapture) {
      ScreenCapture.preventScreenCaptureAsync("zairyu").catch(() => {});
      ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => {});
    }
    const sub = AppState.addEventListener("change", (s) => setCovered(s !== "active"));
    return () => {
      sub.remove();
      ScreenCapture?.allowScreenCaptureAsync("zairyu").catch(() => {});
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {covered && !allowScreenshots && (
        <View style={styles.cover} pointerEvents="none">
          <Text style={styles.text}>在留カード管理</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, backgroundColor: "#0b5cad", alignItems: "center", justifyContent: "center" },
  text: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
