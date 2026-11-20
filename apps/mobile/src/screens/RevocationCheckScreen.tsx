/**
 * 失効情報照会(1-9、半自動)。入管庁のページをアプリ内ブラウザで開き、管理者が照会して結果を記録する。
 * 照会ページへの機械的なアクセスはしない(CLAUDE.md ルール6)。番号は画面を離れると消える
 */
import { REVOCATION_CHECK_URL, REVOCATION_RESULT_LABEL, REVOCATION_RESULTS, type RevocationResult } from "@zairyu/shared";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api, messageOf } from "../api";
import { Button, Card, Choice, color, Field, Message, Screen } from "../ui/kit";

type Info = Awaited<ReturnType<typeof api.verifications.revocationCheckInfo.mutate>>;

/** 2030-06-26 → 2030年06月26日(照会ページの入力に合わせやすい表記) */
const jp = (d: string) => `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日`;

export function RevocationCheckScreen({ cardId, personName, onDone }: { cardId: string; personName: string; onDone: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [result, setResult] = useState<RevocationResult | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ recheckOn: string | null } | null>(null);

  useEffect(() => {
    api.verifications.revocationCheckInfo.mutate({ cardId }).then(setInfo, (e) => setError(messageOf(e)));
    return () => {
      // 画面を離れたら、コピーした番号もクリップボードから消す
      void Clipboard.setStringAsync("");
    };
  }, [cardId]);

  async function copy(label: string, value: string) {
    await Clipboard.setStringAsync(value);
    setCopied(label);
  }

  async function save() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifications.recordRevocationCheck.mutate({ cardId, result, ...(note.trim() ? { note: note.trim() } : {}) });
      setSaved(r);
      setInfo(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <Screen title="失効情報照会">
        <Card>
          <Text style={{ fontWeight: "700" }}>記録しました</Text>
          {result === "revoked" && <Message text="「要確認」にして管理者へ通知しました。本人への確認と、入管局・労働局への相談を行ってください。" />}
          {saved.recheckOn && <Message text={`${saved.recheckOn} の朝に再照会のお知らせを送ります。`} tone="warn" />}
          <Button label="登録者の画面に戻る" onPress={onDone} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={`失効情報照会: ${personName}`} onBack={onDone}>
      <Card>
        <Text style={{ fontWeight: "700" }}>1. 照会に入力する内容</Text>
        {!info && !error && <Text>読み込み中…</Text>}
        {info && (
          <>
            <Text style={{ color: color.sub }}>在留カード番号</Text>
            <Text selectable style={{ fontSize: 26, letterSpacing: 2, fontWeight: "700" }}>
              {info.cardNumber}
            </Text>
            <Button label={copied === "number" ? "番号をコピーしました" : "番号をコピー"} kind="secondary" onPress={() => void copy("number", info.cardNumber)} />
            <Text style={{ color: color.sub, marginTop: 8 }}>有効期間の満了日</Text>
            {info.validUntil ? (
              <>
                <Text selectable style={{ fontSize: 22, fontWeight: "700" }}>
                  {jp(info.validUntil)}
                </Text>
                {info.validUntilBasis === "stay" && (
                  <Message text="カードの有効期限が未登録のため、在留期間の満了日を表示しています。券面の「このカードは○年○月○日まで有効」と同じか確認してください。" tone="warn" />
                )}
              </>
            ) : (
              <Message text="満了日が登録されていません。券面の「このカードは○年○月○日まで有効」を見て入力してください。" tone="warn" />
            )}
          </>
        )}
      </Card>

      <Card>
        <Text style={{ fontWeight: "700" }}>2. 入管庁のページで照会する</Text>
        <Text>番号と満了日を入力して照会し、結果を確認したらこのアプリに戻ってください。</Text>
        <Button label="照会ページを開く" disabled={!info} onPress={() => void WebBrowser.openBrowserAsync(REVOCATION_CHECK_URL)} />
      </Card>

      <Card>
        <Text style={{ fontWeight: "700" }}>3. 結果を記録する</Text>
        <Choice options={REVOCATION_RESULTS.map((r) => ({ value: r, label: REVOCATION_RESULT_LABEL[r] }))} value={result} onChange={setResult} />
        {result === "not_found" && <Text style={{ color: color.sub }}>交付当日のカードは翌日以降に照会できるようになります。翌朝に再照会のお知らせを送ります。</Text>}
        <View style={{ marginTop: 4 }}>
          <Field label="メモ(任意)" value={note} onChangeText={setNote} placeholder="例: 照会画面で「有効」と表示" />
        </View>
        <Message text={error} />
        <Button label="記録する" busy={busy} disabled={!result || !info} onPress={save} />
      </Card>
    </Screen>
  );
}
