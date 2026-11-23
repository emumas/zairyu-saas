/**
 * カード登録ウィザード(1-7、DESIGN.md 4章)
 *   1. 表面撮影(端末内 OCR で番号)→ 2. 番号確認 → 3. IC 読取 → 4. 照合結果の確認 → 5. 裏面撮影 → 6. 保存
 * - 撮影画像・IC のデータはこの画面のメモリにだけ置き、保存後・中断時に破棄する(一時ファイルは撮影直後に削除)
 * - サーバーは保存時にも IC を検証し直す
 */
import {
  ADDRESS_SOURCE_LABEL,
  chooseAddress,
  RETIRE_REASON_LABEL,
  isValidCardNumber,
  normalizeCardNumberInput,
  WORK_RESTRICTION_LABEL,
  WORK_RESTRICTIONS,
  type AddressSource,
  type CardManualFields,
  type FrontOcrFields,
  type IcReadPayload,
} from "@zairyu/shared";
import { useState } from "react";
import { Switch, Text, View } from "react-native";
import { api, messageOf } from "../api";
import { IcProgressView, icErrorMessage, isCardReadError, readIcPayload, type IcProgress } from "../ic/readIc";
import { compressForUpload, deleteFile, recognizeBack, recognizeFront } from "../photo";
import { FORMAT_LABEL } from "../screens/format";
import { Button, Card, Choice, color, Field, Message, Row, Screen } from "../ui/kit";
import { CameraCapture } from "../ui/CameraCapture";
import { CardFaceView } from "../ui/CardFaceView";
import { CardImage } from "../ui/CardImage";

type Photo = { contentType: "image/jpeg"; data: string };
type Verify = Awaited<ReturnType<typeof api.cards.verifyIcRead.mutate>>;
type Step = "front" | "number" | "ic" | "confirm" | "back" | "done";
type IcFailure = "unreadable" | "unsupported_device" | "other";

const DIFF_LABEL: Record<string, string> = {
  cardNumber: "在留カード番号",
  expiryDate: "在留期間の満了日",
  cardValidUntil: "カードの有効期限",
  statusOfResidence: "在留資格",
  workRestriction: "就労制限",
  pendingApplication: "更新申請中",
  birthDate: "生年月日",
};

const IC_FAILURE: { value: IcFailure; label: string }[] = [
  { value: "unreadable", label: "読み取れない(カードの破損など)" },
  { value: "unsupported_device", label: "この端末では読み取れない" },
  { value: "other", label: "その他" },
];

export function CardWizard({ personId, personName, onClose, onDone }: { personId: string; personName: string; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>("front");
  const [camera, setCamera] = useState<"front" | "back" | null>(null);
  const [front, setFront] = useState<Photo | null>(null);
  const [back, setBack] = useState<Photo | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [numberInput, setNumberInput] = useState("");
  const [ic, setIc] = useState<IcReadPayload | null>(null);
  const [icFailure, setIcFailure] = useState<IcFailure | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [manual, setManual] = useState<CardManualFields>({});
  const [diffReason, setDiffReason] = useState("");
  /** 永住者・特別永住者(在留期間の定めがない)。券面の日付はカードの有効期限になる */
  const [noStayLimit, setNoStayLimit] = useState(false);
  const [busy, setBusy] = useState(false);
  /** IC 読み取りの進み具合(カードとやり取りした回数) */
  const [icProgress, setIcProgress] = useState<IcProgress>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ icVerified: boolean; needsReview: boolean } | null>(null);
  /** 表面・裏面の端末内 OCR で読み取った候補(画像は外部に送らない) */
  const [frontOcr, setFrontOcr] = useState<FrontOcrFields | null>(null);
  const [backOcrAddress, setBackOcrAddress] = useState<string | null>(null);
  const [backEntries, setBackEntries] = useState(false);
  /** 住居地: 自動で選んだ値(null)か、利用者が直した値 */
  const [addressEdit, setAddressEdit] = useState<string | null>(null);

  const cardNumber = normalizeCardNumberInput(numberInput);
  const numberOk = isValidCardNumber(cardNumber);
  const hasIcText = verify?.format === "gen2" || verify?.format === "tokutei";

  async function onFrontCaptured(path: string) {
    try {
      const { numbers: found, fields } = await recognizeFront(path);
      setFront(await compressForUpload(path));
      setCandidates(found);
      setFrontOcr(fields);
      if (found[0]) setNumberInput(found[0]);
    } finally {
      deleteFile(path);
    }
    setCamera(null);
    setStep("number");
  }

  async function onBackCaptured(path: string) {
    try {
      const b = await recognizeBack(path);
      setBackOcrAddress(b.address);
      setBackEntries(b.hasEntries);
      setBack(await compressForUpload(path));
    } finally {
      deleteFile(path);
    }
    setCamera(null);
  }

  async function readIc() {
    setBusy(true);
    setError(null);
    try {
      const payload = await readIcPayload(cardNumber, setIcProgress);
      setIc(payload);
      setIcFailure(null);
      const v = await api.cards.verifyIcRead.mutate({ personId, cardNumber, ic: payload, manual: {} });
      setVerify(v);
      // 旧様式は IC に文字情報が無いので、表面の読み取り結果を入力欄に入れておく(第2世代は IC の値を使う)
      if (v.format === "legacy") prefillFromFront();
      setStep("confirm");
    } catch (e) {
      setError(isCardReadError(e) ? icErrorMessage(e) : messageOf(e, icErrorMessage(e)));
    } finally {
      setBusy(false);
      setIcProgress(null);
    }
  }

  /** 表面の読み取り結果を、まだ入力していない欄に入れる(確認・修正してもらう) */
  function prefillFromFront() {
    const f = frontOcr;
    if (!f) return;
    const permanentCard = /永住者/.test(f.statusOfResidence ?? "");
    if (permanentCard) setNoStayLimit(true);
    setManual((m) => ({
      ...m,
      statusOfResidence: m.statusOfResidence ?? f.statusOfResidence,
      ...(permanentCard ? { cardValidUntil: m.cardValidUntil ?? f.cardValidUntil, expiryDate: null } : { expiryDate: m.expiryDate ?? f.expiryDate }),
      birthDate: m.birthDate ?? f.birthDate,
      sex: m.sex ?? f.sex,
      nationality: m.nationality ?? f.nationality,
    }));
  }

  /** 入力した値で照合し直す(第2世代は IC の値と比べる) */
  async function recheck() {
    if (!ic) return;
    setBusy(true);
    setError(null);
    try {
      setVerify(await api.cards.verifyIcRead.mutate({ personId, cardNumber, ic, manual }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.cards.register.mutate({
        personId,
        cardNumber,
        ic,
        ...(ic ? {} : { icFailureReason: icFailure ?? "other" }),
        manual: {
          ...manual,
          ...(address.trim() && addressSource && addressSource !== "ic_back" ? { address: address.trim(), addressSource } : {}),
        },
        photos: { ...(front ? { front } : {}), ...(back ? { back } : {}) },
        ...(diffReason.trim() ? { diffReason: diffReason.trim() } : {}),
      });
      // 送信したデータを破棄する(CLAUDE.md ルール4)
      setFront(null);
      setBack(null);
      setIc(null);
      setResult(r);
      setStep("done");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  // 住居地: 裏面に新しい住所がある場合はそちらを採用する(IC の裏面追記 > 裏面の読み取り > 表面の読み取り)
  const icBackAddress = verify?.icBackAddress?.address ?? null;
  const autoAddress = chooseAddress({ icBack: icBackAddress, backPhoto: backOcrAddress, frontPhoto: frontOcr?.address ?? null, backHasEntries: backEntries });
  const address = icBackAddress ? icBackAddress : (addressEdit ?? autoAddress?.address ?? "");
  const addressSource: AddressSource | null = icBackAddress ? "ic_back" : addressEdit !== null ? "manual" : (autoAddress?.source ?? null);

  const needsReason = (verify?.diffs.length ?? 0) > 0;
  /** 在籍中・退職した別の登録者と同じカードなら、保存してもサーバーが止めるので先に進めない */
  const blockedBySameCard = !!verify?.sameCard.some((m) => m.status === "active" || m.status === "retired");
  const manualNeeded = !hasIcText; // 旧様式・IC なしは満了日などを入力する
  const permanent = noStayLimit || verify?.kind === "special_permanent";
  const canSave =
    numberOk &&
    !blockedBySameCard &&
    (!needsReason || diffReason.trim().length > 0) &&
    (!manualNeeded || (permanent ? !!manual.cardValidUntil : !!manual.expiryDate));

  return (
    <Screen title={`カード登録: ${personName}`} onBack={step === "done" ? undefined : onClose}>
      <CameraCapture
        visible={camera !== null}
        title={camera === "back" ? "裏面を撮影" : "表面を撮影"}
        onClose={() => setCamera(null)}
        onCaptured={camera === "back" ? onBackCaptured : onFrontCaptured}
      />

      {step === "front" && (
        <Card>
          <Text style={{ fontWeight: "700" }}>1. 表面を撮影</Text>
          <Text>在留カードの表面を撮影します。番号を端末内で読み取ります(画像は外部の AI に送りません)。</Text>
          <Button label="表面を撮影" onPress={() => setCamera("front")} />
          <Button label="撮影せずに番号を入力" kind="secondary" onPress={() => setStep("number")} />
        </Card>
      )}

      {step === "number" && (
        <Card>
          <Text style={{ fontWeight: "700" }}>2. 在留カード番号の確認</Text>
          <Text>券面の番号と同じか確認してください。違う場合は直してください。</Text>
          <Field
            label="在留カード番号"
            value={numberInput}
            onChangeText={setNumberInput}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
            error={numberInput && !numberOk ? "英字2文字+数字8桁+英字2文字で入力してください" : null}
          />
          {candidates.length > 1 && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: color.sub }}>他の候補</Text>
              {candidates.slice(1).map((c) => (
                <Text key={c} style={{ color: color.primary }} onPress={() => setNumberInput(c)}>
                  {c}
                </Text>
              ))}
            </View>
          )}
          <Button label="次へ(IC 読み取り)" disabled={!numberOk} onPress={() => setStep("ic")} />
          <Button label="撮り直す" kind="secondary" onPress={() => setCamera("front")} />
        </Card>
      )}

      {step === "ic" && (
        <Card>
          <Text style={{ fontWeight: "700" }}>3. IC の読み取り</Text>
          <Text>ボタンを押してから、カードを端末の背面(iPhone は上部)に当て、読み取りが終わるまで動かさないでください(5 秒ほど)。金属の机の上では読めないことがあります。</Text>
          <Button label="IC を読み取る" busy={busy} onPress={readIc} />
          <IcProgressView progress={icProgress} />
          <Message text={error} />
          <Text style={{ color: color.sub, marginTop: 8 }}>IC が読めない場合</Text>
          <Choice options={IC_FAILURE} value={icFailure} onChange={setIcFailure} />
          <Button
            label="IC なしで続ける(IC 未検証として登録)"
            kind="secondary"
            disabled={!icFailure}
            onPress={() => {
              setIc(null);
              setVerify(null);
              prefillFromFront();
              setStep("confirm");
            }}
          />
        </Card>
      )}

      {step === "confirm" && (
        <>
          <Card>
            <Text style={{ fontWeight: "700" }}>4. 照合結果の確認</Text>
            {verify ? (
              <>
                <Row k="様式" v={FORMAT_LABEL[verify.format]} />
                <Row
                  k="電子署名"
                  v={verify.signature.status === "valid" ? "OK(真正)" : verify.signature.status === "absent" ? "なし(年少者のカード)" : "NG"}
                  tone={verify.signature.status === "valid" ? "ok" : verify.signature.status === "absent" ? "warn" : "danger"}
                />
                {verify.signature.status === "valid" && (
                  <Row
                    k="発行者"
                    v={verify.signature.issuerTrusted === true ? "入管庁の証明書で確認済み" : verify.signature.issuerTrusted === false ? "入管庁の証明書と一致しない" : "未確認(該当する証明書なし)"}
                    tone={verify.signature.issuerTrusted === true ? "ok" : verify.signature.issuerTrusted === false ? "danger" : "warn"}
                  />
                )}
                {verify.needsReview && (
                  <Message text="署名の検証に失敗しました。偽造の疑いがあります。「要確認」として登録し、入管局・労働局に相談してください。" />
                )}
                {hasIcText && (
                  <>
                    <Row k="在留期間満了日" v={verify.fields.expiryDate ?? "—"} />
                    <Row k="カード有効期限" v={verify.fields.cardValidUntil ?? "—"} />
                    <Row k="在留資格(コード)" v={verify.fields.statusOfResidence ?? "—"} />
                    <Row k="就労制限" v={verify.fields.workRestriction ? WORK_RESTRICTION_LABEL[verify.fields.workRestriction as keyof typeof WORK_RESTRICTION_LABEL] : "—"} />
                    <Row k="更新申請中" v={verify.fields.pendingApplication ? "はい" : "いいえ"} />
                  </>
                )}
              </>
            ) : (
              <Message text="IC を読み取っていません。券面を見て入力してください(IC 未検証として登録されます)。" tone="warn" />
            )}
          </Card>

          {(front || (verify?.icImages.length ?? 0) > 0) && (
            <Card>
              <Text style={{ fontWeight: "700" }}>券面と IC の画像を見比べる</Text>
              <Text style={{ color: color.sub }}>氏名・顔写真が実物のカードと一致しているか確認してください。</Text>
              {front && <CardImage kind="front" contentType={front.contentType} data={front.data} />}
              {verify?.icImages.some((i) => i.kind === "ic_front") ? (
                <CardFaceView front={verify.icImages.find((i) => i.kind === "ic_front")!} face={verify.icImages.find((i) => i.kind === "ic_face")} />
              ) : (
                verify?.icImages
                  .slice()
                  .sort((a, b) => (a.kind === "ic_face" ? 1 : 0) - (b.kind === "ic_face" ? 1 : 0))
                  .map((img) => <CardImage key={img.kind} kind={img.kind} contentType={img.contentType} data={img.data} />)
              )}
            </Card>
          )}

          {manualNeeded && (
            <Card>
              <Text style={{ fontWeight: "700" }}>券面の記載事項を入力</Text>
              <Text style={{ color: color.sub }}>旧様式のカードは IC に文字情報がないため、券面を見て入力します。</Text>
              <Field
                label="在留資格"
                value={manual.statusOfResidence ?? ""}
                onChangeText={(v) => {
                  setManual({ ...manual, statusOfResidence: v || null });
                  if (/永住者/.test(v)) setNoStayLimit(true);
                }}
                placeholder="技術・人文知識・国際業務"
              />
              {verify?.kind !== "special_permanent" && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Switch
                    value={noStayLimit}
                    onValueChange={(v) => {
                      setNoStayLimit(v);
                      // 入力済みの日付を、選んだ側の項目へ移す
                      const d = manual.expiryDate ?? manual.cardValidUntil ?? null;
                      setManual(v ? { ...manual, expiryDate: null, cardValidUntil: d } : { ...manual, expiryDate: d, cardValidUntil: null });
                    }}
                  />
                  <Text style={{ flex: 1 }}>永住者(在留期間の定めなし)</Text>
                </View>
              )}
              {permanent ? (
                <Field
                  label="カードの有効期限(YYYY-MM-DD)"
                  value={manual.cardValidUntil ?? ""}
                  onChangeText={(v) => setManual({ ...manual, cardValidUntil: v || null, expiryDate: null })}
                  placeholder="2030-06-26"
                  keyboardType="numbers-and-punctuation"
                />
              ) : (
                <Field
                  label="在留期間の満了日(YYYY-MM-DD)"
                  value={manual.expiryDate ?? ""}
                  onChangeText={(v) => setManual({ ...manual, expiryDate: v || null })}
                  placeholder="2029-06-20"
                  keyboardType="numbers-and-punctuation"
                />
              )}
              {permanent && <Text style={{ color: color.sub }}>永住者・特別永住者には在留期間の満了日がありません。券面の日付はカードの有効期限(カードの更新期限)です。</Text>}
              <Text style={{ fontWeight: "600" }}>就労制限の有無</Text>
              <Choice
                options={WORK_RESTRICTIONS.map((w) => ({ value: w, label: WORK_RESTRICTION_LABEL[w] }))}
                value={manual.workRestriction ?? null}
                onChange={(w) => setManual({ ...manual, workRestriction: w })}
              />
              <Field
                label="生年月日(YYYY-MM-DD)"
                value={manual.birthDate ?? ""}
                onChangeText={(v) => setManual({ ...manual, birthDate: v || null })}
                placeholder="1995-04-01"
                keyboardType="numbers-and-punctuation"
              />
              <Text style={{ fontWeight: "600" }}>性別</Text>
              <Choice
                options={[
                  { value: "M" as const, label: "男 M" },
                  { value: "F" as const, label: "女 F" },
                ]}
                value={manual.sex ?? null}
                onChange={(v) => setManual({ ...manual, sex: v })}
              />
              <Field label="国籍・地域" value={manual.nationality ?? ""} onChangeText={(v) => setManual({ ...manual, nationality: v || null })} placeholder="ベトナム" />
              {frontOcr && <Text style={{ color: color.sub }}>表面の読み取り結果を入れています。券面と見比べて、違っていれば直してください。</Text>}
              {!verify && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Switch value={manual.pendingApplication ?? false} onValueChange={(v) => setManual({ ...manual, pendingApplication: v })} />
                  <Text>裏面に「在留期間更新等許可申請中」の記載がある</Text>
                </View>
              )}
            </Card>
          )}

          {verify && verify.sameCard.length > 0 && (
            <Card>
              <Text style={{ fontWeight: "700", color: blockedBySameCard ? color.danger : color.warn }}>
                同じ在留カード番号のほかの登録者がいます(同一人物)
              </Text>
              {verify.sameCard.map((m, i) => (
                <View key={i} style={{ gap: 2 }}>
                  <Text style={{ fontWeight: "600" }}>
                    {m.name ?? "(担当外の拠点)"} {m.employeeCode}・{m.siteName}・{m.status === "active" ? "在籍中" : m.status === "retired" ? `退職(${m.retiredAt ?? ""})` : "アーカイブ済み"}
                    {m.isCurrentCard ? "" : "(過去のカード)"}
                  </Text>
                  {m.status === "active" && <Text style={{ color: color.danger }}>二重登録の疑いです。異動の場合は、その登録者の拠点を変更してください。</Text>}
                  {m.status === "retired" && (
                    <Text style={{ color: color.danger }}>
                      以前在籍していた方です。新しい登録者ではなく、その登録者を「再入社」にしてからカードを登録してください。
                      {m.lastEmployment ? `\n前回の退職: ${m.lastEmployment.retiredAt}・${RETIRE_REASON_LABEL[m.lastEmployment.reasonCode]}${m.lastEmployment.reasonNote ? `・${m.lastEmployment.reasonNote}` : ""}` : ""}
                    </Text>
                  )}
                  {m.status === "archived" && <Text style={{ color: color.sub }}>アーカイブ済みの古い記録です(登録はできます)。</Text>}
                </View>
              ))}
            </Card>
          )}

          {verify && verify.diffs.length > 0 && (
            <Card>
              <Text style={{ fontWeight: "700", color: color.danger }}>券面と IC が一致しません</Text>
              {verify.diffs.map((d) => (
                <Text key={d.field}>
                  {DIFF_LABEL[d.field] ?? d.field}
                  {d.field === "cardNumber" ? "" : `: IC「${String(d.ic)}」/ 入力「${String(d.input)}」`}
                </Text>
              ))}
              <Field label="理由(必須)" value={diffReason} onChangeText={setDiffReason} placeholder="例: 券面の読み間違い" multiline />
            </Card>
          )}
          <Message text={error} />
          {verify && manualNeeded && <Button label="入力内容で照合し直す" kind="secondary" busy={busy} onPress={recheck} />}
          <Button label="次へ(裏面撮影)" disabled={!canSave} onPress={() => setStep("back")} />
        </>
      )}

      {step === "back" && (
        <Card>
          <Text style={{ fontWeight: "700" }}>5. 裏面を撮影</Text>
          <Text>追記欄・資格外活動許可欄を確認するため、裏面を撮影します。</Text>
          <Button label={back ? "裏面を撮り直す" : "裏面を撮影"} kind={back ? "secondary" : "primary"} onPress={() => setCamera("back")} />
          {back && <Message text="裏面を撮影しました" tone="ok" />}
          <Text style={{ fontWeight: "700", marginTop: 8 }}>住居地</Text>
          {icBackAddress ? (
            <>
              <Row k="住居地" v={icBackAddress} />
              <Text style={{ color: color.sub }}>
                裏面に記載された新しい住居地を IC から読み取りました{verify?.icBackAddress?.writtenAt ? `(${verify.icBackAddress.writtenAt} 記載)` : ""}。こちらを登録します。
              </Text>
            </>
          ) : (
            <>
              <Field label="住居地" value={address} onChangeText={setAddressEdit} placeholder="東京都新宿区西新宿2-8-1" multiline />
              <Text style={{ color: color.sub }}>
                {addressSource
                  ? `${ADDRESS_SOURCE_LABEL[addressSource]}の結果です。裏面に新しい住居地の記載があればそちらを優先します。券面と見比べて、違っていれば直してください。`
                  : "読み取れませんでした。券面(裏面に記載があれば裏面の最新の住所)を見て入力してください(任意)。"}
              </Text>
            </>
          )}
          <Message text={error} />
          <Button label="保存する" busy={busy} disabled={!canSave} onPress={save} />
        </Card>
      )}

      {step === "done" && result && (
        <Card>
          <Text style={{ fontWeight: "700" }}>登録しました</Text>
          <Row k="IC 検証" v={result.icVerified ? "検証済み" : "未検証"} tone={result.icVerified ? "ok" : "warn"} />
          {result.needsReview && <Message text="「要確認(偽造の疑い)」として登録しました。" />}
          <Button label="登録者の画面に戻る" onPress={onDone} />
        </Card>
      )}
    </Screen>
  );
}
