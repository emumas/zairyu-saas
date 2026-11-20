/** 登録者の詳細: 現在のカード・期限・カード履歴と確認履歴 */
import { ADDRESS_SOURCE_LABEL, EXPIRY_BUCKET_LABEL, WORK_RESTRICTION_LABEL } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { CardFaceView, type ImageData } from "../ui/CardFaceView";
import { CardImage, IMAGE_KIND_LABEL } from "../ui/CardImage";
import { Button, Card, color, Message, Row, Screen } from "../ui/kit";
import { bucketTone, FORMAT_LABEL, METHOD_LABEL, RESULT_LABEL } from "./format";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;
type Cards = Awaited<ReturnType<typeof api.cards.listForPerson.query>>;

export function PersonScreen({
  personId,
  onBack,
  onRegisterCard,
  onRevocationCheck,
  onReverify,
  onEditDetails,
}: {
  personId: string;
  onBack: () => void;
  onRegisterCard: (personName: string) => void;
  onRevocationCheck: (cardId: string, personName: string) => void;
  onReverify: (cardId: string, personName: string) => void;
  onEditDetails: (personName: string) => void;
}) {
  const session = useSession();
  const [person, setPerson] = useState<Person | null>(null);
  const [cards, setCards] = useState<Cards>([]);
  const [error, setError] = useState<string | null>(null);
  /** 表示中の画像(画面を離れると破棄される) */
  const [shown, setShown] = useState<Record<string, { kind: string } & ImageData>>({});
  const [cardFace, setCardFace] = useState<{ front: ImageData; face: ImageData | null } | null>(null);
  const [loadingImage, setLoadingImage] = useState<string | null>(null);
  /** 全桁表示した番号(この画面を開いている間だけ) */
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function reveal(cardId: string) {
    try {
      const r = await api.cards.revealCardNumber.mutate({ cardId });
      setRevealed((x) => ({ ...x, [cardId]: r.cardNumber }));
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** IC の券面イメージと顔写真から、カードの見た目で表示する(旧様式) */
  async function showCardFace(frontId: string, faceId: string | undefined) {
    setLoadingImage("cardFace");
    try {
      const [front, face] = await Promise.all([
        api.cards.getImage.mutate({ imageId: frontId }),
        faceId ? api.cards.getImage.mutate({ imageId: faceId }) : Promise.resolve(null),
      ]);
      setCardFace({ front, face });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoadingImage(null);
    }
  }

  async function showImage(id: string) {
    setLoadingImage(id);
    try {
      const img = await api.cards.getImage.mutate({ imageId: id });
      setShown((s) => ({ ...s, [id]: img }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoadingImage(null);
    }
  }

  const load = useCallback(async () => {
    try {
      setPerson(await api.persons.get.query({ id: personId }));
      if (session.can("verifications.read")) setCards(await api.cards.listForPerson.query({ personId }));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [personId, session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!person) {
    return (
      <Screen title="登録者" onBack={onBack}>
        <Message text={error ?? "読み込み中…"} tone={error ? "danger" : "warn"} />
      </Screen>
    );
  }
  const c = person.card;
  const e = person.expiry;
  return (
    <Screen title={person.name} onBack={onBack}>
      <Card>
        <Row k="社員番号" v={person.employeeCode} />
        <Row k="拠点" v={person.siteName} />
        <Row k="状態" v={{ active: "在籍", retired: `退職(${person.retiredAt ?? ""})`, archived: "アーカイブ" }[person.status]} />
        {person.nationality && <Row k="国籍・地域" v={person.nationality} />}
        {person.birthDate && <Row k="生年月日" v={person.birthDate} />}
      </Card>

      <Text style={{ fontWeight: "700", fontSize: 16 }}>現在のカード</Text>
      <Card>
        <Row k="期限区分" v={EXPIRY_BUCKET_LABEL[e.bucket]} tone={bucketTone(e.bucket)} />
        {e.deadline && <Row k={e.deadlineBasis === "card" ? "カード有効期限" : "在留期間満了日"} v={`${e.deadline}(残り ${e.daysLeft} 日)`} />}
        {e.specialPeriodUntil && <Row k="特例期間" v={`${e.specialPeriodUntil} まで`} tone="warn" />}
        {c && (
          <>
            <Row k="様式" v={FORMAT_LABEL[c.cardFormat]} />
            <Row k="在留資格" v={c.statusOfResidence ?? "—"} />
            <Row k="就労制限" v={c.workRestriction ? (WORK_RESTRICTION_LABEL[c.workRestriction as keyof typeof WORK_RESTRICTION_LABEL] ?? c.workRestriction) : "—"} />
            <Row k="資格外活動" v={c.outsideActivity ?? "—"} />
            <Row k="IC 検証" v={c.icVerified ? "検証済み" : "未検証"} tone={c.icVerified ? "ok" : "warn"} />
            {c.needsReview && <Row k="要確認" v="署名検証に失敗(偽造の疑い)。入管局・労働局に相談してください" tone="danger" />}
          </>
        )}
      </Card>
      {(() => {
        const cur = cards.find((x) => x.isCurrent);
        if (!cur) return null;
        return (
          <Card>
            <Text style={{ fontWeight: "700" }}>カード記載事項</Text>
            <Row k="在留カード番号" v={revealed[cur.id] ?? cur.cardNumberMasked} />
            {session.can("cards.viewImage") && !revealed[cur.id] && (
              <Button label="番号を全桁表示(記録が残ります)" kind="secondary" onPress={() => void reveal(cur.id)} />
            )}
            <Row k="生年月日" v={cur.birthDate ?? "—"} />
            <Row k="性別" v={cur.sex === "M" ? "男" : cur.sex === "F" ? "女" : "—"} />
            <Row k="国籍・地域" v={cur.nationality ?? "—"} />
            <Row k="住居地" v={cur.address ?? "—"} />
            {cur.address && cur.addressSource && (
              <Text style={{ color: color.sub, fontSize: 12 }}>
                {ADDRESS_SOURCE_LABEL[cur.addressSource as keyof typeof ADDRESS_SOURCE_LABEL] ?? cur.addressSource}
                {cur.addressWrittenAt ? `(${cur.addressWrittenAt} 記載)` : ""}
              </Text>
            )}
            <Row k="在留資格" v={cur.statusOfResidence ?? "—"} />
            {cur.periodOfStay && <Row k="在留期間" v={cur.periodOfStay} />}
            {cur.permittedAt && <Row k="許可年月日" v={cur.permittedAt} />}
            <Row k="在留期間満了日" v={cur.expiryDate ?? "—"} />
            <Row k="カードの有効期限" v={cur.cardValidUntil ?? "—"} />
            {session.can("cards.write") && person.status === "active" && (
              <Button label="保存済みの写真から読み取る・直す" kind="secondary" onPress={() => onEditDetails(person.name)} />
            )}
          </Card>
        );
      })()}
      {session.can("cards.viewImage") && cards.find((x) => x.isCurrent)?.images.length ? (
        <Card>
          <Text style={{ fontWeight: "700" }}>カード画像</Text>
          <Text style={{ color: color.sub, fontSize: 13 }}>表示した記録が監査ログに残ります。</Text>
          {(() => {
            const imgs = cards.find((x) => x.isCurrent)!.images;
            const front = imgs.find((i) => i.kind === "ic_front");
            if (!front) return null;
            return cardFace ? (
              <CardFaceView front={cardFace.front} face={cardFace.face} />
            ) : (
              <Button label="IC の記録をカードの見た目で表示" busy={loadingImage === "cardFace"} onPress={() => void showCardFace(front.id, imgs.find((i) => i.kind === "ic_face")?.id)} />
            );
          })()}
          {cards
            .find((x) => x.isCurrent)!
            .images.slice()
            .sort((a, b) => a.kind.localeCompare(b.kind))
            .map((img) =>
              shown[img.id] ? (
                <CardImage key={img.id} {...shown[img.id]!} />
              ) : (
                <Button
                  key={img.id}
                  label={`${IMAGE_KIND_LABEL[img.kind] ?? img.kind}を表示`}
                  kind="secondary"
                  busy={loadingImage === img.id}
                  onPress={() => void showImage(img.id)}
                />
              ),
            )}
        </Card>
      ) : null}
      <Message text={error} />
      {c && session.can("cards.write") && person.status === "active" && (
        <Button label="IC を再検証" kind="secondary" onPress={() => onReverify(c.id, person.name)} />
      )}
      {c && session.can("verifications.write") && (
        <Button label="失効情報照会" kind="secondary" onPress={() => onRevocationCheck(c.id, person.name)} />
      )}
      {session.can("cards.write") && person.status === "active" && (
        <Button label={c ? "新しいカードを登録" : "カードを登録"} onPress={() => onRegisterCard(person.name)} />
      )}

      {cards.length > 0 && <Text style={{ fontWeight: "700", fontSize: 16 }}>カード履歴と確認履歴</Text>}
      {cards.map((card) => (
        <Card key={card.id}>
          <Text style={{ fontWeight: "600" }}>
            {FORMAT_LABEL[card.cardFormat]} ・ {card.createdAt.toString().slice(0, 10)} 登録{card.isCurrent ? "(現在)" : ""}
          </Text>
          {card.verifications.map((v) => (
            <Text key={v.id} style={{ color: v.result === "ok" ? color.text : color.warn }}>
              {new Date(v.performedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} {METHOD_LABEL[v.method] ?? v.method}: {RESULT_LABEL[v.result] ?? v.result}
              {v.note ? `(${v.note})` : ""}
            </Text>
          ))}
        </Card>
      ))}
    </Screen>
  );
}
