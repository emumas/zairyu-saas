/** 登録者の追加(社員番号・氏名・拠点。国籍・生年月日は任意) */
import { useState } from "react";
import { Text } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Choice, Field, Message, Screen } from "../ui/kit";

export function PersonCreateScreen({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const session = useSession();
  const sites = session.state.status === "signedIn" ? session.state.me.sites : [];
  const [siteId, setSiteId] = useState<string | null>(sites.length === 1 ? sites[0]!.id : null);
  const [employeeCode, setEmployeeCode] = useState("");
  const [name, setName] = useState("");
  const [nationality, setNationality] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.persons.create.mutate({
        siteId,
        employeeCode: employeeCode.trim(),
        name: name.trim(),
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
    <Screen title="登録者を追加" onBack={onBack}>
      <Text style={{ fontWeight: "600" }}>拠点</Text>
      {sites.length === 0 ? (
        <Message text="担当の拠点がありません。管理者に拠点の割り当てを依頼してください。" tone="warn" />
      ) : (
        <Choice options={sites.map((s) => ({ value: s.id, label: s.name }))} value={siteId} onChange={setSiteId} />
      )}
      <Field label="社員番号" value={employeeCode} onChangeText={setEmployeeCode} autoCapitalize="characters" autoCorrect={false} />
      <Field label="氏名" value={name} onChangeText={setName} placeholder="カードの表記どおり" />
      <Field label="国籍・地域(任意。英大文字 3 文字)" value={nationality} onChangeText={setNationality} placeholder="VNM" autoCapitalize="characters" maxLength={3} />
      <Field label="生年月日(任意。YYYY-MM-DD)" value={birthDate} onChangeText={setBirthDate} placeholder="1995-04-01" keyboardType="numbers-and-punctuation" />
      <Message text={error} />
      <Button label="追加する" busy={busy} disabled={!siteId || !employeeCode.trim() || !name.trim()} onPress={save} />
    </Screen>
  );
}
