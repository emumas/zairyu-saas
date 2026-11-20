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
import { CardNumberScanner } from "./CardNumberScanner";
import { randomBytes, tokuteiDeliveryKey } from "./config";
import { getLastTrace, isNfcAvailable, maxReadLengthFor, withIsoDep } from "./nfc";

type VerifyResult = Awaited<ReturnType<typeof api.poc.verifyIcRead.mutate>>;

interface Measurement {
  format: CardFormat;
  readMs: number;
  apduCount: number;
  /** カードとの通信時間の合計 */
  transceiveMs: number;
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
    return `署名OK(${issuer}、対象=${s.matched}${s.hashFormat ? `、${s.hashFormat}` : ""})`;
  }
  if (s.status === "absent") return "署名なし(年少者カード)";
  return `署名NG: ${s.reason}${s.detail ? `(${s.detail})` : ""}`;
}

/** 個人情報を含まない診断情報(エラーの種類・段階・SW・送受信のヘッダ) */
function diagnose(e: unknown, phase: "nfc" | "api"): string {
  const lines: string[] = [`段階: ${phase === "nfc" ? "IC 読み取り" : "サーバー検証"}`];
  if (e instanceof CardReadError) {
    lines.push(`種類: ${e.name} / step=${e.step} / SW=${e.sw === null ? "-" : e.sw.toString(16).toUpperCase()}`);
  } else if (e instanceof Error) {
    lines.push(`種類: ${e.name}`, `内容: ${e.message.slice(0, 200)}`);
  } else {
    lines.push(`種類: ${typeof e} / ${String(e).slice(0, 200)}`);
  }
  if (phase === "nfc") {
    const t = getLastTrace();
    lines.push(`最大送受信長: ${t.maxTransceiveLength ?? "-"}`);
    for (const x of t.entries) {
      lines.push(`${x.header} → ${x.error ? `例外 ${x.error}` : `SW ${x.sw ?? "-"} (${x.responseLength}B)`}`);
    }
  }
  return lines.join("\n");
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
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [result, setResult] = useState<(VerifyResult & Measurement) | null>(null);
  const [history, setHistory] = useState<Measurement[]>([]);
  const [nfcOk, setNfcOk] = useState<boolean | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  /** OCR で入力した番号(手で直したかの判定用) */
  const [ocrNumber, setOcrNumber] = useState<string | null>(null);
  const [ocrCandidates, setOcrCandidates] = useState<string[]>([]);
  const [ocrStats, setOcrStats] = useState({ shots: 0, found: 0, confirmedByIc: 0, rejectedByIc: 0, editedByUser: 0 });

  const cardNumber = normalizeCardNumberInput(input);
  const valid = isValidCardNumber(cardNumber);

  useEffect(() => {
    isNfcAvailable().then(setNfcOk, () => setNfcOk(false));
    // バックグラウンドに移ったら表示中の個人情報を消す
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") {
        setResult(null);
        setInput("");
        setOcrNumber(null);
        setOcrCandidates([]);
      }
    });
    return () => sub.remove();
  }, []);

  /** IC 認証の成否で OCR の番号が正しかったかを数える(IC 認証が通る = 番号が正しい) */
  function recordOcrOutcome(icAccepted: boolean) {
    if (!ocrNumber) return;
    setOcrStats((st) => {
      if (cardNumber !== ocrNumber) return { ...st, editedByUser: st.editedByUser + 1 };
      return icAccepted ? { ...st, confirmedByIc: st.confirmedByIc + 1 } : { ...st, rejectedByIc: st.rejectedByIc + 1 };
    });
    setOcrNumber(null);
  }

  function onOcrResult(r: { candidates: string[] }) {
    setScannerOpen(false);
    setOcrStats((st) => ({ ...st, shots: st.shots + 1, found: st.found + 1 }));
    setOcrCandidates(r.candidates);
    setOcrNumber(r.candidates[0]!);
    setInput(r.candidates[0]!);
  }

  async function onRead() {
    setBusy(true);
    setError(null);
    setDiagnostic(null);
    setResult(null);
    let phase: "nfc" | "api" = "nfc";
    try {
      const { raw, apduCount, transceiveMs } = await withIsoDep(async (transceive, info) => {
        const maxReadLength = maxReadLengthFor(info);
        const deliveryKey = tokuteiDeliveryKey();
        const r = await readResidenceCard(transceive, {
          cardNumber,
          randomBytes,
          ...(maxReadLength ? { maxReadLength } : {}),
          ...(deliveryKey ? { tokuteiDeliveryKey: deliveryKey } : {}),
        });
        return { raw: r, apduCount: info.apduCount(), transceiveMs: info.transceiveMs() };
      });
      phase = "api";
      const files: Record<string, string> = {};
      for (const [path, data] of Object.entries(raw.files)) if (data) files[path] = toBase64(data);
      const verified = await api.poc.verifyIcRead.mutate({ format: raw.format, kind: raw.kind, files });
      const m: Measurement = {
        format: raw.format,
        readMs: raw.elapsedMs,
        apduCount,
        transceiveMs,
        signatureText: signatureLabel(verified.signature),
      };
      setResult({ ...verified, ...m });
      setHistory((h) => [m, ...h].slice(0, 20));
      recordOcrOutcome(true);
    } catch (e) {
      setError(phase === "api" ? "サーバーでの検証に失敗しました。API が起動しているか、.env の URL を確認してください。" : errorMessage(e));
      setDiagnostic(diagnose(e, phase));
      const numberRejected =
        e instanceof CardNumberMismatchError || (e instanceof CardReadError && e.step === "mutual_authenticate");
      if (numberRejected) recordOcrOutcome(false);
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
      <Pressable style={styles.secondary} disabled={busy} onPress={() => setScannerOpen(true)}>
        <Text style={styles.secondaryText}>券面を撮影して番号を読む</Text>
      </Pressable>
      {ocrCandidates.length > 1 && (
        <View style={styles.row}>
          <Text style={styles.key}>他の候補</Text>
          <View style={styles.value}>
            {ocrCandidates.slice(1).map((c) => (
              <Pressable key={c} onPress={() => { setInput(c); setOcrNumber(c); }}>
                <Text style={styles.link}>{c}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {ocrNumber && <Text style={styles.hint}>読み取った番号を券面と見比べて確認してください</Text>}

      <Pressable style={[styles.button, (!valid || busy) && styles.buttonDisabled]} disabled={!valid || busy} onPress={onRead}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>ICを読み取る</Text>}
      </Pressable>
      {busy && Platform.OS === "android" && <Text style={styles.hint}>カードを端末の背面にかざしてください</Text>}
      {error && <Text style={styles.ng}>{error}</Text>}
      {diagnostic && (
        <View style={styles.card}>
          <Text style={styles.label}>診断情報(個人情報は含みません)</Text>
          <Text selectable style={styles.mono}>
            {diagnostic}
          </Text>
        </View>
      )}

      {result && (
        <View style={styles.card}>
          <Row k="様式" v={FORMAT_LABEL[result.format]} />
          <Row k="署名" v={result.signatureText} />
          <Row k="読取時間" v={`${result.readMs} ms(通信 ${result.transceiveMs} ms / 処理 ${result.readMs - result.transceiveMs} ms、APDU ${result.apduCount} 回)`} />
          <Text style={styles.label}>APDU ごとの時間(診断用)</Text>
          <Text selectable style={styles.mono}>
            {getLastTrace()
              .entries.map((e) => `${e.header} → ${e.sw ?? "-"} ${e.responseLength ?? "-"}B ${e.ms ?? "-"}ms`)
              .join("\n")}
          </Text>
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
          <Text style={styles.label}>EF 構造(診断用)</Text>
          <Text selectable style={styles.mono}>
            {Object.entries(result.structure)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")}
          </Text>
          <Pressable onPress={() => setResult(null)}>
            <Text style={styles.link}>結果を消去</Text>
          </Pressable>
        </View>
      )}

      {ocrStats.shots > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>OCR 計測</Text>
          <Text style={styles.mono}>
            撮影 {ocrStats.shots} / 候補あり {ocrStats.found} / IC で正しさ確認 {ocrStats.confirmedByIc} / IC で誤り判明{" "}
            {ocrStats.rejectedByIc} / 手で修正 {ocrStats.editedByUser}
          </Text>
        </View>
      )}

      <CardNumberScanner
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onResult={onOcrResult}
        onFailedShot={() => setOcrStats((st) => ({ ...st, shots: st.shots + 1 }))}
      />

      {history.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>計測履歴(個人情報は残しません)</Text>
          {history.map((h, i) => (
            <Text key={i} style={styles.mono}>
              {FORMAT_LABEL[h.format]} {h.readMs}ms(通信{h.transceiveMs}) APDU{h.apduCount} {h.signatureText}
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
  secondary: { borderWidth: 1, borderColor: "#0b5cad", borderRadius: 8, padding: 12, alignItems: "center" },
  secondaryText: { color: "#0b5cad", fontSize: 15, fontWeight: "600" },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
});
