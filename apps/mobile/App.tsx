import { isValidCardNumber, normalizeCardNumberInput } from "@zairyu/shared";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

/**
 * フェーズ0 PoC の仮画面。
 * TODO(0-4/0-5/0-6): 表面撮影(端末内OCR)→ NFC 読み取り → サーバーで署名検証 の流れに置き換える。
 */
export default function App() {
  const [input, setInput] = useState("");
  const normalized = normalizeCardNumberInput(input);
  const valid = isValidCardNumber(normalized);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>在留カード番号</Text>
      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="AB12345678CD"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={20}
      />
      {input.length > 0 && (
        <Text style={valid ? styles.ok : styles.ng}>{valid ? "形式OK" : "英字2文字+数字8桁+英字2文字で入力してください"}</Text>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", alignItems: "stretch", justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 18, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 12, fontSize: 20, letterSpacing: 2 },
  ok: { color: "#1a7f37" },
  ng: { color: "#cf222e" },
});
