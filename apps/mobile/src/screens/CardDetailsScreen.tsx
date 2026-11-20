/**
 * カード記載事項の確認・修正。保存済みの撮影画像(表面・裏面)を端末内 OCR で読み取り、
 * 現在の登録内容と並べて確認してから保存する(カードが手元に無くても使える)。
 * - 画像は外部に送らない(CLAUDE.md ルール3)。一時ファイルは読み取り後すぐ消す(ルール4)
 * - 画像の取得は閲覧として監査ログに残る
 * - 第2世代の記載事項と、IC の裏面追記から取った住居地は IC の値なので変えない(表示のみ)
 */
import { ADDRESS_SOURCE_LABEL, chooseAddress, type AddressSource, type FrontOcrFields } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { api, messageOf } from "../api";
import { recognizeBackAddress, recognizeFront, recognizeSavedImage } from "../photo";
import { Button, Card, Choice, color, Field, Message, Row, Screen } from "../ui/kit";

type CardRow = Awaited<ReturnType<typeof api.cards.listForPerson.query>>[number];
type Form = {
  birthDate: string;
  sex: "M" | "F" | null;
  nationality: string;
  statusOfResidence: string;
  expiryDate: string;
  cardValidUntil: string;
  address: string;
};

const fromCard = (c: CardRow): Form => ({
  birthDate: c.birthDate ?? "",
  sex: c.sex === "M" || c.sex === "F" ? c.sex : null,
  nationality: c.nationality ?? "",
  statusOfResidence: c.statusOfResidence ?? "",
  expiryDate: c.expiryDate ?? "",
  cardValidUntil: c.cardValidUntil ?? "",
  address: c.address ?? "",
});

const orNull = (s: string) => (s.trim() ? s.trim() : null);

export function CardDetailsScreen({ personId, personName, onClose, onSaved }: { personId: string; personName: string; onClose: () => void; onSaved: () => void }) {
  const [card, setCard] = useState<CardRow | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [front, setFront] = useState<FrontOcrFields | null>(null);
  const [backAddress, setBackAddress] = useState<string | null>(null);
  const [addressSource, setAddressSource] = useState<AddressSource | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [reading, setReading] = useState(false);
  const [readDone, setReadDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.cards.listForPerson.query({ personId }).then(
      (cards) => {
        const c = cards.find((x) => x.isCurrent) ?? null;
        setCard(c);
        if (c) {
          setForm(fromCard(c));
          setPermanent(!c.expiryDate && !!c.cardValidUntil);
        }
      },
      (e) => setError(messageOf(e)),
    );
  }, [personId]);

  if (!card || !form) return <Screen title={`記載事項: ${personName}`} onBack={onClose}>{error ? <Message text={error} /> : <Text>読み込み中…</Text>}</Screen>;

  const legacy = card.cardFormat === "legacy";
  const addressFromIc = card.addressSource === "ic_back";
  const frontImage = card.images.find((i) => i.kind === "front");
  const backImage = card.images.find((i) => i.kind === "back");

  /** 保存済みの写真を取り寄せて端末内で読み取り、入力欄に入れる(現在の値は下に表示する) */
  async function readPhotos() {
    setReading(true);
    setError(null);
    setMsg(null);
    try {
      const f = frontImage ? await recognizeSavedImage((await api.cards.getImage.mutate({ imageId: frontImage.id })).data, recognizeFront) : null;
      const b = backImage ? await recognizeSavedImage((await api.cards.getImage.mutate({ imageId: backImage.id })).data, recognizeBackAddress) : null;
      const fields = f?.fields ?? null;
      setFront(fields);
      setBackAddress(b);
      setForm((cur) => {
        if (!cur) return cur;
        const next = { ...cur };
        if (legacy && fields) {
          if (fields.birthDate) next.birthDate = fields.birthDate;
          if (fields.sex) next.sex = fields.sex;
          if (fields.nationality) next.nationality = fields.nationality;
          if (fields.statusOfResidence) next.statusOfResidence = fields.statusOfResidence;
          if (fields.expiryDate) next.expiryDate = fields.expiryDate;
          if (fields.cardValidUntil) next.cardValidUntil = fields.cardValidUntil;
        }
        // 住居地: 裏面に新しい住所があればそちらを採用する
        const chosen = addressFromIc ? null : chooseAddress({ backPhoto: b, frontPhoto: fields?.address ?? null });
        if (chosen) {
          next.address = chosen.address;
          setAddressSource(chosen.source);
        }
        return next;
      });
      if (legacy && fields && /永住者/.test(fields.statusOfResidence ?? "")) setPermanent(true);
      setReadDone(true);
    } catch (e) {
      setError(messageOf(e, "写真を読み取れませんでした"));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!card || !form) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const input: Parameters<typeof api.cards.updateDetails.mutate>[0] = { cardId: card.id };
      if (legacy) {
        input.birthDate = orNull(form.birthDate);
        input.sex = form.sex;
        input.nationality = orNull(form.nationality);
        input.statusOfResidence = orNull(form.statusOfResidence);
        input.expiryDate = permanent ? null : orNull(form.expiryDate);
        input.cardValidUntil = orNull(form.cardValidUntil);
      }
      if (!addressFromIc) {
        input.address = orNull(form.address);
        input.addressSource = addressSource && addressSource !== "ic_back" ? addressSource : "manual";
      }
      const r = await api.cards.updateDetails.mutate(input);
      setMsg(`保存しました(${r.changed.length} 項目)`);
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  /** 読み取り結果と現在の登録の違いを示す */
  const was = (v: string | null | undefined) => <Text style={{ color: color.sub, fontSize: 12 }}>登録済み: {v || "—"}</Text>;

  return (
    <Screen title={`記載事項: ${personName}`} onBack={onClose}>
      <Card>
        <Text style={{ fontWeight: "700" }}>保存済みの写真から読み取る(任意)</Text>
        <Text style={{ color: color.sub }}>
          登録時に撮影した表面{backImage ? "・裏面" : ""}の写真を端末内で読み取ります(外部には送りません。写真の閲覧として記録が残ります)。
          {!frontImage && !backImage ? "このカードには撮影した写真がありません。" : ""}
          読み取れなかった項目や写真が無い場合は、下の欄に直接入力して保存できます。
        </Text>
        <Button label={readDone ? "もう一度読み取る" : "写真を読み取る"} busy={reading} disabled={!frontImage && !backImage} onPress={() => void readPhotos()} />
        {readDone && <Message text="読み取った値を入力欄に入れました。券面の写真と見比べて、違っていれば直してから保存してください。" tone="ok" />}
      </Card>

      <Card>
        <Text style={{ fontWeight: "700" }}>記載事項</Text>
        {legacy ? (
          <>
            <Field label="生年月日(YYYY-MM-DD)" value={form.birthDate} onChangeText={(v) => setForm({ ...form, birthDate: v })} keyboardType="numbers-and-punctuation" />
            {readDone && was(card.birthDate)}
            <Text style={{ fontWeight: "600" }}>性別</Text>
            <Choice
              options={[
                { value: "M" as const, label: "男 M" },
                { value: "F" as const, label: "女 F" },
              ]}
              value={form.sex}
              onChange={(v) => setForm({ ...form, sex: v })}
            />
            {readDone && was(card.sex === "M" ? "男" : card.sex === "F" ? "女" : null)}
            <Field label="国籍・地域" value={form.nationality} onChangeText={(v) => setForm({ ...form, nationality: v })} />
            {readDone && was(card.nationality)}
            <Field label="在留資格" value={form.statusOfResidence} onChangeText={(v) => setForm({ ...form, statusOfResidence: v })} />
            {readDone && was(card.statusOfResidence)}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Switch value={permanent} onValueChange={setPermanent} />
              <Text style={{ flex: 1 }}>永住者(在留期間の定めなし)</Text>
            </View>
            {!permanent && (
              <>
                <Field label="在留期間の満了日(YYYY-MM-DD)" value={form.expiryDate} onChangeText={(v) => setForm({ ...form, expiryDate: v })} keyboardType="numbers-and-punctuation" />
                {readDone && was(card.expiryDate)}
              </>
            )}
            <Field label="カードの有効期限(YYYY-MM-DD)" value={form.cardValidUntil} onChangeText={(v) => setForm({ ...form, cardValidUntil: v })} keyboardType="numbers-and-punctuation" />
            {readDone && was(card.cardValidUntil)}
            <Text style={{ color: color.sub, fontSize: 12 }}>満了日・有効期限を変えると、期限の区分とアラートも変わります。</Text>
          </>
        ) : (
          <>
            <Text style={{ color: color.sub }}>第2世代のカードは IC の値を使っています(ここでは変更できません)。</Text>
            <Row k="生年月日" v={card.birthDate ?? "—"} />
            <Row k="性別" v={card.sex === "M" ? "男" : card.sex === "F" ? "女" : "—"} />
            <Row k="国籍・地域" v={card.nationality ?? "—"} />
            <Row k="在留資格" v={card.statusOfResidence ?? "—"} />
            <Row k="在留期間満了日" v={card.expiryDate ?? "—"} />
            <Row k="カードの有効期限" v={card.cardValidUntil ?? "—"} />
          </>
        )}
      </Card>

      <Card>
        <Text style={{ fontWeight: "700" }}>住居地</Text>
        {addressFromIc ? (
          <>
            <Row k="住居地" v={card.address ?? "—"} />
            <Text style={{ color: color.sub }}>IC に記録された裏面の住居地です{card.addressWrittenAt ? `(${card.addressWrittenAt} 記載)` : ""}。変更は IC の再検証で行います。</Text>
          </>
        ) : (
          <>
            <Field
              label="住居地"
              value={form.address}
              onChangeText={(v) => {
                setForm({ ...form, address: v });
                setAddressSource("manual");
              }}
              multiline
            />
            {readDone && was(card.address)}
            {addressSource && <Text style={{ color: color.sub, fontSize: 12 }}>入力欄の値: {ADDRESS_SOURCE_LABEL[addressSource]}。裏面に新しい住所の記載があればそちらを優先します。</Text>}
            {readDone && !front?.address && !backAddress && <Text style={{ color: color.sub, fontSize: 12 }}>写真から住居地を読み取れませんでした。</Text>}
          </>
        )}
      </Card>
      <Message text={error} />
      <Message text={msg} tone="ok" />
      <Button label="保存する" busy={busy} disabled={!legacy && addressFromIc} onPress={() => void save()} />
    </Screen>
  );
}
