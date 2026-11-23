/**
 * 登録者の追加・編集(社員番号・氏名・フリガナ・拠点。国籍・生年月日・電話番号・入社日は任意)。
 * 追加のときは、同一人物と思われる登録者を確かめる:
 * - 在籍中の人 → 二重登録の疑い(異動なら既存の登録者の拠点を変える)
 * - 退職した人 → 前回の退職理由を出し、再入社を勧める
 */
import { jstDate, RETIRE_REASON_LABEL } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Card, Choice, color, Field, Message, Screen } from "../ui/kit";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;
type Similar = Awaited<ReturnType<typeof api.persons.findSimilar.query>>[number];

export function PersonCreateScreen({
  onBack,
  onCreated,
  person,
  initial,
  note,
  submitLabel,
}: {
  onBack: () => void;
  onCreated: (id: string) => void;
  person?: Person;
  /** 在留カードから読み取った下書き(追加のとき) */
  initial?: { name?: string | null; nationality?: string | null; birthDate?: string | null };
  note?: string;
  submitLabel?: string;
}) {
  const session = useSession();
  const sites = session.state.status === "signedIn" ? session.state.me.sites : [];
  const editing = !!person;
  const [siteId, setSiteId] = useState<string | null>(person?.siteId ?? (sites.length === 1 ? sites[0]!.id : null));
  const [employeeCode, setEmployeeCode] = useState(person?.employeeCode ?? "");
  const [name, setName] = useState(person?.name ?? initial?.name ?? "");
  const [nameKana, setNameKana] = useState(person?.nameKana ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [nationality, setNationality] = useState(person?.nationality ?? initial?.nationality ?? "");
  const [birthDate, setBirthDate] = useState(person?.birthDate ?? initial?.birthDate ?? "");
  const [hiredAt, setHiredAt] = useState(person?.hiredAt ?? (person ? "" : jstDate(Date.now())));
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  // 追加のときだけ、同一人物と思われる登録者を探す(氏名か、フリガナ+生年月日が入ってから)
  useEffect(() => {
    if (editing || name.trim().length < 2) return setSimilar([]);
    const t = setTimeout(() => {
      api.persons.findSimilar
        .query({ name: name.trim(), ...(nameKana.trim() ? { nameKana: nameKana.trim() } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(birthDate.trim()) ? { birthDate: birthDate.trim() } : {}) })
        .then(setSimilar, () => setSimilar([]));
    }, 500);
    return () => clearTimeout(t);
  }, [editing, name, nameKana, birthDate]);

  /** 退職した登録者を再入社にする(新しく登録しない) */
  async function rehire(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.persons.reactivate.mutate({ id, ...(hiredAt.trim() ? { hiredAt: hiredAt.trim() } : {}) });
      onCreated(id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    try {
      if (person) {
        // 変わった項目だけ送る(空欄にした任意項目は消す)
        const patch: Parameters<typeof api.persons.update.mutate>[0] = { id: person.id };
        if (siteId !== person.siteId) patch.siteId = siteId;
        if (employeeCode.trim() !== person.employeeCode) patch.employeeCode = employeeCode.trim();
        if (name.trim() !== person.name) patch.name = name.trim();
        if (nameKana.trim() !== (person.nameKana ?? "")) patch.nameKana = nameKana.trim();
        if (phone.trim() !== (person.phone ?? "")) patch.phone = phone.trim();
        if (nationality.trim().toUpperCase() !== (person.nationality ?? "")) patch.nationality = nationality.trim() ? nationality.trim().toUpperCase() : null;
        if (birthDate.trim() !== (person.birthDate ?? "")) patch.birthDate = birthDate.trim() || null;
        if (hiredAt.trim() !== (person.hiredAt ?? "")) patch.hiredAt = hiredAt.trim() || null;
        if (Object.keys(patch).length === 1) {
          onCreated(person.id);
          return;
        }
        await api.persons.update.mutate(patch);
        onCreated(person.id);
        return;
      }
      const { id } = await api.persons.create.mutate({
        siteId,
        employeeCode: employeeCode.trim(),
        name: name.trim(),
        ...(nameKana.trim() ? { nameKana: nameKana.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(nationality.trim() ? { nationality: nationality.trim().toUpperCase() } : {}),
        ...(birthDate.trim() ? { birthDate: birthDate.trim() } : {}),
        ...(hiredAt.trim() ? { hiredAt: hiredAt.trim() } : {}),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      });
      onCreated(id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={editing ? "登録者の情報を編集" : "登録者を追加"} onBack={onBack}>
      {note && <Message text={note} tone="ok" />}
      <Text style={{ fontWeight: "600" }}>拠点</Text>
      {sites.length === 0 ? (
        <Message text="担当の拠点がありません。管理者に拠点の割り当てを依頼してください。" tone="warn" />
      ) : (
        <Choice options={sites.map((s) => ({ value: s.id, label: s.name }))} value={siteId} onChange={setSiteId} />
      )}
      <Field label="社員番号" value={employeeCode} onChangeText={setEmployeeCode} autoCapitalize="characters" autoCorrect={false} />
      <Field label="氏名" value={name} onChangeText={setName} placeholder="カードの表記どおり" />
      <Field label="フリガナ(任意。ひらがなでも可)" value={nameKana} onChangeText={setNameKana} placeholder="グエン ヴァン アー" />
      <Field label="電話番号(任意)" value={phone} onChangeText={setPhone} placeholder="090-1234-5678" keyboardType="phone-pad" />
      <Field label="国籍・地域(任意。英大文字 3 文字)" value={nationality} onChangeText={setNationality} placeholder="VNM" autoCapitalize="characters" maxLength={3} />
      <Field label="生年月日(任意。YYYY-MM-DD)" value={birthDate} onChangeText={setBirthDate} placeholder="1995-04-01" keyboardType="numbers-and-punctuation" />
      <Field label="入社日(任意。YYYY-MM-DD)" value={hiredAt} onChangeText={setHiredAt} placeholder="2024-04-01" keyboardType="numbers-and-punctuation" />
      {similar.length > 0 && (
        <Card>
          <Text style={{ fontWeight: "700", color: color.warn }}>同一人物と思われる登録者がいます</Text>
          {similar.map((p, i) => (
            <View key={i} style={{ gap: 4, borderTopWidth: i ? 1 : 0, borderColor: color.border, paddingTop: i ? 6 : 0 }}>
              <Text style={{ fontWeight: "600" }}>
                {p.name ?? "(担当外の拠点)"} {p.employeeCode}・{p.siteName}・{p.status === "active" ? "在籍中" : p.status === "retired" ? `退職(${p.retiredAt ?? ""})` : "アーカイブ"}
                {p.strong ? "" : "(氏名だけ一致)"}
              </Text>
              {p.status === "active" && <Text style={{ color: color.sub }}>二重登録の疑いがあります。異動の場合は、新しく追加せずに既存の登録者の拠点を変更してください。</Text>}
              {p.lastEmployment && (
                <Text style={{ color: color.sub }}>
                  前回の退職: {p.lastEmployment.retiredAt}・{RETIRE_REASON_LABEL[p.lastEmployment.reasonCode]}
                  {p.lastEmployment.reasonNote ? `・${p.lastEmployment.reasonNote}` : ""}
                </Text>
              )}
              {p.status === "retired" && p.id && <Button label="この方を再入社にする(新しく追加しない)" busy={busy} onPress={() => void rehire(p.id!)} />}
              {p.status === "retired" && !p.id && <Text style={{ color: color.sub }}>担当外の拠点の方です。再入社は管理者に依頼してください。</Text>}
            </View>
          ))}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch value={confirmDuplicate} onValueChange={setConfirmDuplicate} />
            <Text style={{ flex: 1 }}>別人であることを確かめたので、新しく追加する</Text>
          </View>
        </Card>
      )}
      <Message text={error} />
      <Button label={submitLabel ?? (editing ? "保存する" : "追加する")} busy={busy} disabled={!siteId || !employeeCode.trim() || !name.trim()} onPress={save} />
    </Screen>
  );
}
