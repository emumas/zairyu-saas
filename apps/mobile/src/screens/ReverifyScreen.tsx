/**
 * IC 再検証(1-8): 登録済みのカードの IC を読み直して署名を検証し、確認履歴に追記する。
 * 更新申請中・資格外活動など、交付後に IC へ追記された内容も反映される
 */
import { useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { IcProgressView, icErrorMessage, isCardReadError, readIcPayload, type IcProgress } from "../ic/readIc";
import { Button, Card, Message, Row, Screen } from "../ui/kit";

type Result = Awaited<ReturnType<typeof api.cards.reverifyIc.mutate>>;

const FIELD_LABEL: Record<string, string> = {
  pendingApplication: "更新申請中",
  outsideActivity: "資格外活動許可",
  outsideActivityUntil: "資格外活動許可の期限",
  address: "住居地(IC の裏面の記載に更新)",
};
const show = (v: string | boolean | null) => (v === null ? "—" : v === true ? "はい" : v === false ? "いいえ" : v);

export function ReverifyScreen({ cardId, personName, onDone }: { cardId: string; personName: string; onDone: () => void }) {
  const [progress, setProgress] = useState<IcProgress>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      // IC の認証には登録済みの番号を使う(番号の表示として監査ログに残る)
      const { cardNumber } = await api.cards.reverifyStart.mutate({ cardId });
      const ic = await readIcPayload(cardNumber, setProgress);
      setResult(await api.cards.reverifyIc.mutate({ cardId, ic }));
    } catch (e) {
      setError(isCardReadError(e) ? icErrorMessage(e) : messageOf(e, icErrorMessage(e)));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Screen title={`IC 再検証: ${personName}`} onBack={onDone}>
      {!result ? (
        <Card>
          <Text>登録済みのカードの IC を読み直し、電子署名を確認します。更新申請中・資格外活動許可など、カードに追記された内容も反映されます。</Text>
          <Text>ボタンを押してから、カードを端末の背面(iPhone は上部)に当て、読み取りが終わるまで動かさないでください。</Text>
          <Button label="IC を読み取る" busy={busy} onPress={run} />
          <IcProgressView progress={progress} />
          <Message text={error} />
        </Card>
      ) : (
        <Card>
          <Text style={{ fontWeight: "700" }}>再検証しました</Text>
          <Row
            k="電子署名"
            v={result.signature === "valid" ? "OK(真正)" : result.signature === "absent" ? "なし(年少者のカード)" : "NG"}
            tone={result.signature === "valid" ? "ok" : result.signature === "absent" ? "warn" : "danger"}
          />
          {result.signature === "valid" && (
            <Row
              k="発行者"
              v={result.issuerTrusted === true ? "入管庁の証明書で確認済み" : result.issuerTrusted === false ? "入管庁の証明書と一致しない" : "未確認(該当する証明書なし)"}
              tone={result.issuerTrusted === true ? "ok" : result.issuerTrusted === false ? "danger" : "warn"}
            />
          )}
          {result.icBackAddress && (
            <>
              <Row
                k="IC の住居地(裏面の記載)"
                v={result.icBackAddress.recorded ? `記録あり${result.icBackAddress.writtenAt ? `(${result.icBackAddress.writtenAt} 記録)` : ""}` : "記録なし"}
                tone={result.icBackAddress.recorded ? "ok" : undefined}
              />
              {!result.icBackAddress.recorded && (
                <Text style={{ color: "#59636e", fontSize: 12 }}>旧様式のカードは、住居地の変更が裏面に印字されるだけで IC には記録されないことがあります。その場合は裏面の写真から読み取った住所を使います。</Text>
              )}
            </>
          )}
          {result.needsReview && <Message text="署名の検証に失敗しました。「要確認」にして管理者へ通知しました。入管局・労働局に相談してください。" />}
          {result.changes.length > 0 ? (
            <>
              <Text style={{ fontWeight: "600" }}>カードに追記されていた内容を反映しました</Text>
              {result.changes.map((c) => (
                <Row key={c.field} k={FIELD_LABEL[c.field] ?? c.field} v={c.field === "address" ? "更新しました" : `${show(c.before)} → ${show(c.after)}`} tone="warn" />
              ))}
            </>
          ) : (
            <Text>登録内容から変わった項目はありません。</Text>
          )}
          <Button label="登録者の画面に戻る" onPress={onDone} />
        </Card>
      )}
    </Screen>
  );
}
