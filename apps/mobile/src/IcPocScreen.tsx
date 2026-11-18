/**
 * フェーズ0 PoC: 在留カード番号を入力し、IC を読み出してサーバーで署名検証する。
 * 読み出したデータはメモリ上にのみ保持し、送信後・バックグラウンド移行時に破棄する(CLAUDE.md ルール4)。
 */
import { isValidCardNumber, normalizeCardNumberInput } from "@zairyu/shared";
import {
  CardNumberMismatchError,
  CardReadError,
  readResidenceCard,
  toBase64,
  type CardFormat,
} from "@zairyu/zairyu-ic";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api } from "./api";
import { randomBytes, tokuteiDeliveryKey } from "./config";
import { isNfcAvailable, maxReadLengthFor, withIsoDep } from "./nfc";

type VerifyResult = Awaited<ReturnType<typeof api.poc.verifyIcRead.mutate>>;

interface Measurement {
  format: CardFormat;
  readMs: number;
  apduCount: number;
  signatureText: string;
}

const FORMAT_LABEL: Record<CardFormat, string> = {
  legacy: "旧様式",
  gen2: "第2世代",
  tokutei: "特定在留カード",
};

function signatureLabel(s: VerifyResult["signature"]): string {
  if (s.status === "valid") {
    const issuer = s.issuerTrusted === null ? "発行者未確認" : s.issuerTrusted ? "発行者OK" : "発行者NG";
    return `署名OK(${issuer})`;
  }
  if (s.status === "absent") return "署名なし(年少者カード)";
  return `署名NG: ${s.reason}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof CardNumberMismatchError) return "在留カード番号が一致しません。番号を確認してください。";
  if (e instanceof CardReadError) {
    if (e.step === "mutual_authenticate") return "カードとの認証に失敗しました。番号が正しいか確認してください。";
    if (e.step === "set_session_key") return e.message;
    return `読み取りに失敗しました(${e.step})。カードをかざし直してください。`;
  }
  return "読み取りに失敗しました。カードをかざし直してください。";
}

export function IcPocScreen() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(VerifyResult & Measurement) | null>(null);
  const [history, setHistory] = useState<Measurement[]>([]);
  const [nfcOk, setNfcOk] = useState<boolean | null>(null);

  const cardNumber = normalizeCardNumberInput(input);
  const valid = isValidCardNumber(cardNumber);

  useEffect(() => {
    isNfcAvailable().then(setNfcOk, () => setNfcOk(false));
    // バックグラウンドに移ったら表示中の個人情報を消す
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") {
        setResult(null);
        setInput("");
      }
    });
    return () => sub.remove();
  }, []);

  async function onRead() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { raw, apduCount } = await withIsoDep(async (transceive, info) => {
        const maxReadLength = maxReadLengthFor(info);
        const deliveryKey = tokuteiDeliveryKey();
        const r = await readResidenceCard(transceive, {
          cardNumber,
          randomBytes,
          ...(maxReadLength ? { maxReadLength } : {}),
          ...(deliveryKey ? { tokuteiDeliveryKey: deliveryKey } : {}),
        });
        return { raw: r, apduCount: info.apduCount() };
      });
      const files: Record<string, string> = {};
      for (const [path, data] of Object.entries(raw.files)) if (data) files[path] = toBase64(data);
      const verified = await api.poc.verifyIcRead.mutate({ format: raw.format, kind: raw.kind, files });
      const m: Measurement = {
        format: raw.format,
        readMs: raw.elapsedMs,
        apduCount,
        signatureText: signatureLabel(verified.signature),
      };
      setResult({ ...verified, ...m });
      setHistory((h) => [m, ...h].slice(0, 20));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>IC読み取り PoC</Text>
      {nfcOk === false && <Text style={styles.ng}>この端末では NFC が使えないか、オフになっています。</Text>}

      <Text style={styles.label}>在留カード番号</Text>
      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="AB12345678CD"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={20}
        editable={!busy}
      />
      {input.length > 0 && !valid && <Text style={styles.ng}>英字2文字+数字8桁+英字2文字で入力してください</Text>}

      <Pressable style={[styles.button, (!valid || busy) && styles.buttonDisabled]} disabled={!valid || busy} onPress={onRead}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>ICを読み取る</Text>}
      </Pressable>
      {busy && Platform.OS === "android" && <Text style={styles.hint}>カードを端末の背面にかざしてください</Text>}
      {error && <Text style={styles.ng}>{error}</Text>}

      {result && (
        <View style={styles.card}>
          <Row k="様式" v={FORMAT_LABEL[result.format]} />
          <Row k="署名" v={result.signatureText} />
          <Row k="読取時間" v={`${result.readMs} ms(APDU ${result.apduCount} 回)`} />
          {result.cardNumber && <Row k="IC内の番号" v={result.cardNumber === cardNumber ? "券面と一致" : "券面と不一致"} />}
          {result.faceItems &&
            Object.entries(result.faceItems).map(([k, v]) => <Row key={k} k={k} v={v ?? "—"} />)}
          {Object.entries(result.back).map(([k, v]) => (
            <Row key={k} k={k} v={v === null ? "—" : String(v)} />
          ))}
          <Row
            k="画像(バイト)"
            v={`券面 ${result.images.front} / 顔 ${result.images.face} / 氏名 ${result.images.name} / 住居地 ${result.images.address}`}
          />
          <Pressable onPress={() => setResult(null)}>
            <Text style={styles.link}>結果を消去</Text>
          </Pressable>
        </View>
      )}

      {history.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>計測履歴(個人情報は残しません)</Text>
          {history.map((h, i) => (
            <Text key={i} style={styles.mono}>
              {FORMAT_LABEL[h.format]} {h.readMs}ms APDU{h.apduCount} {h.signatureText}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.key}>{k}</Text>
      <Text style={styles.value}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64, gap: 12 },
  title: { fontSize: 22, fontWeight: "700" },
  label: { fontSize: 15, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 12, fontSize: 20, letterSpacing: 2 },
  button: { backgroundColor: "#0b5cad", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  hint: { color: "#555" },
  ng: { color: "#cf222e" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 6 },
  row: { flexDirection: "row", gap: 8 },
  key: { width: 140, color: "#555" },
  value: { flex: 1 },
  link: { color: "#0b5cad", marginTop: 8 },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
});
