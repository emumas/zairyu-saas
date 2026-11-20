/**
 * 在籍(入社日・退職・再入社)と在籍期間の履歴。
 * 退職理由のメモは個人の事情を含みうるので、閲覧者には API が返さない
 */
import { jstDate, RETIRE_REASON_LABEL, RETIRE_REASONS, type RetireReason } from "@zairyu/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Card, Choice, color, Field, Message, Row } from "../ui/kit";
import type { Person } from "./PersonScreen";

export function EmploymentCard({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const session = useSession();
  const today = jstDate(Date.now());
  const [mode, setMode] = useState<"retire" | "rehire" | null>(null);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<RetireReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = session.can("persons.write");

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "retire" && reason) await api.persons.retire.mutate({ id: person.id, retiredAt: date, reasonCode: reason, ...(note.trim() ? { reasonNote: note.trim() } : {}) });
      if (mode === "rehire") await api.persons.reactivate.mutate({ id: person.id, hiredAt: date });
      setMode(null);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text style={{ fontWeight: "700" }}>在籍</Text>
      <Row k="入社日" v={person.hiredAt ?? "—"} />
      {person.status === "retired" && <Row k="退職日" v={person.retiredAt ?? "—"} />}
      {person.employments.length > 0 && (
        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: "600", marginTop: 4 }}>これまでの在籍</Text>
          {person.employments.map((e, i) => (
            <View key={i} style={{ borderTopWidth: i ? 1 : 0, borderColor: color.border, paddingTop: i ? 4 : 0 }}>
              <Text>
                {e.hiredAt ?? "入社日不明"} 〜 {e.retiredAt}
                {e.siteName ? `(${e.siteName})` : ""}
              </Text>
              <Text style={{ color: color.sub }}>
                退職理由: {RETIRE_REASON_LABEL[e.reasonCode]}
                {e.reasonNote ? ` ・ ${e.reasonNote}` : ""}
              </Text>
            </View>
          ))}
        </View>
      )}
      {canWrite && person.status === "active" && mode === null && (
        <Button label="退職の手続き" kind="secondary" onPress={() => { setDate(today); setReason(null); setNote(""); setMode("retire"); }} />
      )}
      {canWrite && person.status === "retired" && mode === null && (
        <Button label="再入社にする" kind="secondary" onPress={() => { setDate(today); setMode("rehire"); }} />
      )}
      {mode === "retire" && (
        <>
          <Field label="退職日(YYYY-MM-DD)" value={date} onChangeText={setDate} keyboardType="numbers-and-punctuation" />
          <Text style={{ fontWeight: "600" }}>退職理由</Text>
          <Choice options={RETIRE_REASONS.map((r) => ({ value: r, label: RETIRE_REASON_LABEL[r] }))} value={reason} onChange={setReason} />
          <Field label="メモ(任意)" value={note} onChangeText={setNote} multiline placeholder="再入社の判断に必要なことを書きます" />
          <Text style={{ color: color.sub, fontSize: 12 }}>退職日の翌日から課金の人数に数えません。退職理由は再入社のときに表示されます(閲覧者には表示しません)。</Text>
        </>
      )}
      {mode === "rehire" && (
        <>
          {person.employments[0] && (
            <Message
              text={`前回の退職: ${person.employments[0].retiredAt}(${RETIRE_REASON_LABEL[person.employments[0].reasonCode]}${person.employments[0].reasonNote ? `・${person.employments[0].reasonNote}` : ""})`}
              tone="warn"
            />
          )}
          <Field label="入社日(YYYY-MM-DD)" value={date} onChangeText={setDate} keyboardType="numbers-and-punctuation" />
        </>
      )}
      <Message text={error} />
      {mode && (
        <>
          <Button label={mode === "retire" ? "退職にする" : "再入社にする"} busy={busy} disabled={mode === "retire" && !reason} onPress={() => void submit()} />
          <Button label="やめる" kind="secondary" onPress={() => setMode(null)} />
        </>
      )}
    </Card>
  );
}
