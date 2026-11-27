/**
 * IC 再検証(1-8): 登録済みのカードの IC を読み直して署名を検証し、確認履歴に追記する。
 * 更新申請中・資格外活動など、交付後に IC へ追記された内容も反映される
 */
import { ADDRESS_SOURCE_LABEL } from "@zairyu/shared";
import { useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { correctAddress } from "../addressFix";
import { IcProgressView, icErrorMessage, isCardReadError, readIcPayload, type IcProgress } from "../ic/readIc";
import { recognizeIcAddressImage } from "../photo";
import { CardImage } from "../ui/CardImage";
import { Button, Card, Field, Message, Row, Screen } from "../ui/kit";

/** 住所の比較用(空白・全角半角・ハイフンの違いは同じとみなす) */
const sameAddress = (a: string, b: string) => {
  const n = (s: string) => s.normalize("NFKC").replace(/[\s\u3000]/g, "").replace(/[‐−ー―-]/g, "-");
  return n(a) === n(b);
};

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
  /** 第2世代: IC の住居地イメージを端末内 OCR で読んだ住所(undefined はまだ、null は読めなかった) */
  const [icAddr, setIcAddr] = useState<string | null | undefined>(undefined);
  const [addrEdit, setAddrEdit] = useState("");
  const [addrSaved, setAddrSaved] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      // IC の認証には登録済みの番号を使う(番号の表示として監査ログに残る)
      const { cardNumber } = await api.cards.reverifyStart.mutate({ cardId });
      const ic = await readIcPayload(cardNumber, setProgress);
      const r = await api.cards.reverifyIc.mutate({ cardId, ic });
      setResult(r);
      if (r.icAddress) {
        // 画像は外部に送らず端末内で読む。地名の読み違いは自社の郵便番号データで直す
        const read = await recognizeIcAddressImage(r.icAddress.image.data);
        const fixed = read ? (await correctAddress(read)).address : null;
        setIcAddr(fixed);
        setAddrEdit(fixed ?? "");
      }
    } catch (e) {
      setError(isCardReadError(e) ? icErrorMessage(e) : messageOf(e, icErrorMessage(e)));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function saveAddress() {
    setBusy(true);
    setError(null);
    try {
      await api.cards.updateDetails.mutate({ cardId, address: addrEdit.trim(), addressSource: "ic_image" });
      setAddrSaved(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const addr = result?.icAddress ?? null;

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
          {addr && (
            <>
              <Text style={{ fontWeight: "600", marginTop: 8 }}>住居地(IC の住居地イメージ)</Text>
              <CardImage kind="ic_address" contentType="image/png" data={addr.image.data} width={addr.image.width} height={addr.image.height} />
              {icAddr === null ? (
                <Text style={{ color: "#59636e" }}>画像から住所を読み取れませんでした。登録済みの住居地と見比べ、違っていれば「記載事項を入力・直す」で直してください。</Text>
              ) : icAddr && addr.stored && sameAddress(icAddr, addr.stored) ? (
                <Row k="住居地" v="登録済みの住居地と一致" tone="ok" />
              ) : icAddr ? (
                addrSaved ? (
                  <Message text="住居地を更新しました(郵便番号も住所から引き直します)。" tone="ok" />
                ) : (
                  <>
                    <Row k="登録済み" v={addr.stored ? `${addr.stored}${addr.storedSource ? `(${ADDRESS_SOURCE_LABEL[addr.storedSource as keyof typeof ADDRESS_SOURCE_LABEL] ?? addr.storedSource})` : ""}` : "—"} />
                    <Text>IC の住居地イメージの内容が登録済みの住居地と違います。画像と見比べて、正しければ更新してください(住居地の変更届のあと、IC の記録が書き換えられていることがあります)。</Text>
                    <Field label="IC から読み取った住居地" value={addrEdit} onChangeText={setAddrEdit} multiline />
                    <Button label="住居地をこの内容に更新" busy={busy} disabled={!addrEdit.trim()} onPress={() => void saveAddress()} />
                    <Message text={error} />
                  </>
                )
              ) : null}
            </>
          )}
          <Button label="登録者の画面に戻る" onPress={onDone} />
        </Card>
      )}
    </Screen>
  );
}
