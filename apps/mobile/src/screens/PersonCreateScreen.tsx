/** 登録者の追加・編集(社員番号・氏名・フリガナ・拠点。国籍・生年月日・電話番号は任意) */
import { useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Choice, Field, Message, Screen } from "../ui/kit";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;

export function PersonCreateScreen({ onBack, onCreated, person }: { onBack: () => void; onCreated: (id: string) => void; person?: Person }) {
  const session = useSession();
  const sites = session.state.status === "signedIn" ? session.state.me.sites : [];
  const editing = !!person;
  const [siteId, setSiteId] = useState<string | null>(person?.siteId ?? (sites.length === 1 ? sites[0]!.id : null));
  const [employeeCode, setEmployeeCode] = useState(person?.employeeCode ?? "");
  const [name, setName] = useState(person?.name ?? "");
  const [nameKana, setNameKana] = useState(person?.nameKana ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [nationality, setNationality] = useState(person?.nationality ?? "");
  const [birthDate, setBirthDate] = useState(person?.birthDate ?? "");
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
      <Message text={error} />
      <Button label={editing ? "保存する" : "追加する"} busy={busy} disabled={!siteId || !employeeCode.trim() || !name.trim()} onPress={save} />
    </Screen>
  );
}
