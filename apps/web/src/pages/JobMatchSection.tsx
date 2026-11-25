/** 登録者の画面: 職種照合(テスト運用) */
import { JOB_MATCH_LEVEL_LABEL, SSW_FIELDS, type SswField } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { useJobMatchingEnabled } from "../jobMatching";
import { useSession } from "../session";
import { Button, Card, fmtDateTime, Message } from "../ui";

type Data = Awaited<ReturnType<typeof api.jobs.person.query>>;
type Category = Awaited<ReturnType<typeof api.jobs.categories.list.query>>[number];
const LEVEL_CLASS = { ok: "w-ok", check: "w-check", ng: "w-ng", none: "" } as const;

export function JobMatchSection({ personId, editable }: { personId: string; editable: boolean }) {
  const enabled = useJobMatchingEnabled();
  const session = useSession();
  const canEdit = editable && session.can("persons.write");
  const [data, setData] = useState<Data | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.jobs.person.query({ personId }).then(setData, (e: unknown) => setError(messageOf(e)));
  }, [personId]);
  useEffect(() => {
    if (!enabled) return;
    load();
    api.jobs.categories.list.query().then(setCats, () => setCats([]));
  }, [enabled, load]);
  if (!enabled || !data) return null;

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
      setChecked([]);
      setNote("");
      load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const items = [...new Set(data.match.checks)];

  return (
    <Card title="職種照合(テスト運用)">
      <div className="row wrap">
        <label className="field">
          <span>職種</span>
          <select
            value={data.jobCategoryId ?? ""}
            disabled={!canEdit || busy}
            onChange={(e) => void run(() => api.jobs.assign.mutate({ personId, jobCategoryId: e.target.value || null }))}
          >
            <option value="">未設定</option>
            {cats
              .filter((c) => !c.archivedAt || c.id === data.jobCategoryId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>指定書の特定技能の分野(特定技能の人だけ)</span>
          <select
            value={data.sswField ?? ""}
            disabled={!canEdit || busy}
            onChange={(e) => void run(() => api.jobs.assign.mutate({ personId, sswField: (e.target.value || null) as SswField | null }))}
          >
            <option value="">未登録</option>
            {SSW_FIELDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={`work-level ${LEVEL_CLASS[data.match.level]}`}>{JOB_MATCH_LEVEL_LABEL[data.match.level]}</p>
      <ul>
        {data.match.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <Message text={error} />
      {data.jobCategoryId && data.match.checks.length > 0 && canEdit && (
        <>
          <h3>確認の記録</h3>
          {items.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={checked.includes(c)} onChange={(e) => setChecked(e.target.checked ? [...checked, c] : checked.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
          <label className="field">
            <span>メモ(確認した方法・内容)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <div className="row">
            <Button busy={busy} disabled={checked.length < items.length} onClick={() => void run(() => api.jobs.check.mutate({ personId, result: "ok", items: checked, note: note || null }))}>
              すべて確認した(問題なし)
            </Button>
            <Button kind="secondary" busy={busy} onClick={() => void run(() => api.jobs.check.mutate({ personId, result: "concern", items: checked, note: note || null }))}>
              懸念ありとして記録
            </Button>
          </div>
        </>
      )}
      {data.history.length > 0 && (
        <details>
          <summary>確認の記録 {data.history.length} 件</summary>
          <ul>
            {data.history.map((h) => (
              <li key={h.id}>
                {fmtDateTime(h.checkedAt)}・{h.jobName}・{h.result === "ok" ? "問題なし" : "懸念あり"}・{h.checkedByEmail ?? ""}
                {h.note ? `・${h.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="sub">テスト運用の機能です。在留資格と職種からの目安で、最終的な判断は雇用主が行ってください。確認の記録は変更・削除できません。</p>
    </Card>
  );
}
