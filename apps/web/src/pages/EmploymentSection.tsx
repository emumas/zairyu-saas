/** 在籍(入社日・退職の手続き・再入社)と在籍期間の履歴。退職理由は閲覧者には API が返さない */
import { jstDate, RETIRE_REASON_LABEL, RETIRE_REASONS, type RetireReason } from "@zairyu/shared";
import { useState } from "react";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, Message } from "../ui";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;

export function EmploymentSection({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const session = useSession();
  const today = jstDate(Date.now());
  const [mode, setMode] = useState<"retire" | "rehire" | null>(null);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<RetireReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = session.can("persons.write");
  const last = person.employments[0];

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
    <Card
      title="在籍"
      actions={
        canWrite && !mode ? (
          person.status === "active" ? (
            <Button kind="secondary" onClick={() => { setDate(today); setReason(""); setNote(""); setMode("retire"); }}>
              退職の手続き
            </Button>
          ) : person.status === "retired" ? (
            <Button kind="secondary" onClick={() => { setDate(today); setMode("rehire"); }}>
              再入社にする
            </Button>
          ) : null
        ) : null
      }
    >
      <dl>
        <dt>入社日</dt>
        <dd>{person.hiredAt ?? "—"}</dd>
        {person.status === "retired" && (
          <>
            <dt>退職日</dt>
            <dd>{person.retiredAt ?? "—"}</dd>
          </>
        )}
      </dl>
      {mode === "retire" && (
        <div className="row wrap">
          <label className="field">
            <span>退職日</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>退職理由</span>
            <select value={reason} onChange={(e) => setReason(e.target.value as RetireReason)}>
              <option value="">選んでください</option>
              {RETIRE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {RETIRE_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 260 }}>
            <span>メモ(任意。再入社の判断に必要なこと)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
        </div>
      )}
      {mode === "rehire" && (
        <>
          {last && (
            <Message
              tone="warn"
              text={`前回の退職: ${last.retiredAt}(${RETIRE_REASON_LABEL[last.reasonCode]}${last.reasonNote ? `・${last.reasonNote}` : ""})`}
            />
          )}
          <label className="field">
            <span>入社日</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </>
      )}
      <Message text={error} />
      {mode && (
        <div className="row">
          <Button kind="secondary" onClick={() => setMode(null)}>
            やめる
          </Button>
          <Button busy={busy} disabled={mode === "retire" && !reason} onClick={() => void submit()}>
            {mode === "retire" ? "退職にする" : "再入社にする"}
          </Button>
        </div>
      )}
      {person.employments.length > 0 && (
        <>
          <h3>これまでの在籍</h3>
          <table>
            <thead>
              <tr>
                <th>入社日</th>
                <th>退職日</th>
                <th>拠点</th>
                <th>退職理由</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {person.employments.map((e, i) => (
                <tr key={i}>
                  <td>{e.hiredAt ?? "—"}</td>
                  <td>{e.retiredAt}</td>
                  <td>{e.siteName ?? "—"}</td>
                  <td>{RETIRE_REASON_LABEL[e.reasonCode]}</td>
                  <td>{e.reasonNote ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
