/** 職種照合(テスト運用): 自社の職種の登録。職種ごとに、単純作業を含むか・風俗営業等に当たるか・特定技能の分野を決める */
import { SSW_FIELDS, type SswField } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, Message } from "../ui";

type Category = Awaited<ReturnType<typeof api.jobs.categories.list.query>>[number];
type Form = { name: string; simpleWork: boolean; adultEntertainment: boolean; sswField: string; note: string };
const EMPTY: Form = { name: "", simpleWork: false, adultEntertainment: false, sswField: "", note: "" };

function CategoryForm({ initial, onSave, onCancel }: { initial: Form; onSave: (f: Form) => Promise<void>; onCancel?: () => void }) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <div className="row wrap">
      <label className="field">
        <span>職種名</span>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={50} placeholder="例: 食品製造ライン" />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.simpleWork} onChange={(e) => setF({ ...f, simpleWork: e.target.checked })} />
        単純作業を含む(ライン作業・清掃・梱包・接客レジなど)
      </label>
      <label className="check">
        <input type="checkbox" checked={f.adultEntertainment} onChange={(e) => setF({ ...f, adultEntertainment: e.target.checked })} />
        風俗営業等に当たる(接待飲食など)
      </label>
      <label className="field">
        <span>特定技能の分野(特定技能の人を配置する職種なら)</span>
        <select value={f.sswField} onChange={(e) => setF({ ...f, sswField: e.target.value })}>
          <option value="">なし</option>
          {SSW_FIELDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>メモ(業務内容など)</span>
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} />
      </label>
      {onCancel && (
        <Button kind="secondary" onClick={onCancel}>
          やめる
        </Button>
      )}
      <Button
        busy={busy}
        disabled={!f.name.trim()}
        onClick={() => {
          setBusy(true);
          void onSave(f).finally(() => setBusy(false));
        }}
      >
        保存
      </Button>
    </div>
  );
}

const toInput = (f: Form) => ({ name: f.name, simpleWork: f.simpleWork, adultEntertainment: f.adultEntertainment, sswField: (f.sswField || null) as SswField | null, note: f.note || null });

export function JobsPage() {
  const session = useSession();
  const canEdit = session.can("tenant.settings");
  const [list, setList] = useState<Category[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.jobs.categories.list.query().then(setList, (e: unknown) => setError(messageOf(e))), []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      setError(null);
      setEditing(null);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const label = (k: string | null) => SSW_FIELDS.find(([key]) => key === k)?.[1] ?? "—";

  return (
    <>
      <h1>職種(職種照合・テスト運用)</h1>
      <Card>
        <p>
          自社の職種を登録し、登録者の画面で割り当てると、在留資格で働ける職種かの<b>目安</b>を出します。最終的な判断は雇用主が行ってください。
        </p>
        <p className="sub">
          テスト運用の機能です。判定の規則と特定技能の分野の一覧は、制度の改正(2026年の分野の追加、2027年4月の育成就労への移行など)で変わります。追加された分野の受入れ開始の時期は分野ごとに異なるため、出入国在留管理庁の分野別情報で確かめてください。
        </p>
      </Card>
      <Message text={error} />
      {canEdit && (
        <Card title="職種を追加">
          <CategoryForm initial={EMPTY} onSave={(f) => run(api.jobs.categories.create.mutate(toInput(f)))} />
        </Card>
      )}
      <Card title={`職種 ${list.length} 件`}>
        <table>
          <thead>
            <tr>
              <th>職種名</th>
              <th>単純作業</th>
              <th>風俗営業等</th>
              <th>特定技能の分野</th>
              <th>メモ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) =>
              editing === c.id ? (
                <tr key={c.id}>
                  <td colSpan={6}>
                    <CategoryForm
                      initial={{ name: c.name, simpleWork: c.simpleWork, adultEntertainment: c.adultEntertainment, sswField: c.sswField ?? "", note: c.note ?? "" }}
                      onSave={(f) => run(api.jobs.categories.update.mutate({ id: c.id, ...toInput(f) }))}
                      onCancel={() => setEditing(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={c.id} className={c.archivedAt ? "muted" : ""}>
                  <td>{c.name}</td>
                  <td>{c.simpleWork ? "含む" : "—"}</td>
                  <td>{c.adultEntertainment ? <span className="b-expired">当たる</span> : "—"}</td>
                  <td>{label(c.sswField)}</td>
                  <td>{c.note ?? ""}</td>
                  <td className="row">
                    {canEdit && (
                      <>
                        <Button kind="secondary" onClick={() => setEditing(c.id)}>
                          編集
                        </Button>
                        <Button kind="secondary" onClick={() => void run(api.jobs.categories.update.mutate({ id: c.id, archived: !c.archivedAt }))}>
                          {c.archivedAt ? "使用を再開" : "使わない"}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
