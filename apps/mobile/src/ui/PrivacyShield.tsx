/**
 * 端末保護(1-20、CLAUDE.md ルール4)
 * - スクリーンショット・画面録画を禁止(Android は FLAG_SECURE。最近使ったアプリの一覧のサムネイルも黒くなる)
 * - iOS のアプリ切り替え画面ではぼかす
 * - アプリが前面でなくなったら(切り替え画面の撮影時を含む)画面全体を無地で覆う
 * 開発用ビルドに限り EXPO_PUBLIC_ALLOW_SCREENSHOTS=1 で無効にできる(画面を共有して確認するため)
 */
import * as ScreenCapture from "expo-screen-capture";
import { useEffect, useState, type ReactNode } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";

const allowScreenshots = __DEV__ && process.env.EXPO_PUBLIC_ALLOW_SCREENSHOTS === "1";

export function PrivacyShield({ children }: { children: ReactNode }) {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    if (!allowScreenshots) {
      ScreenCapture.preventScreenCaptureAsync("zairyu").catch(() => {});
      ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => {});
    }
    const sub = AppState.addEventListener("change", (s) => setCovered(s !== "active"));
    return () => {
      sub.remove();
      ScreenCapture.allowScreenCaptureAsync("zairyu").catch(() => {});
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
