import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, messageOf } from "../api";
import { Button, Card, fmtDateTime, Message } from "../ui";

type Site = Awaited<ReturnType<typeof api.org.sites.list.query>>[number];

export function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.org.sites.list.query().then(setSites, (e) => setError(messageOf(e))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = (p: Promise<unknown>) =>
    p.then(
      () => {
        setError(null);
        return load();
      },
      (e) => setError(messageOf(e)),
    );

  return (
    <>
      <h1>拠点</h1>
      <Card title="拠点を追加">
        <form
          className="row"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(api.org.sites.create.mutate({ name }).then(() => setName("")));
          }}
        >
          <input placeholder="拠点名(例: 大阪工場)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <Button type="submit">追加</Button>
        </form>
      </Card>
      <Message text={error} />
      <table>
        <thead>
          <tr>
            <th>拠点名</th>
            <th>作成日時</th>
            <th>状態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id} className={s.archivedAt ? "muted" : ""}>
              <td>
                {editing?.id === s.id ? (
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={100} />
                ) : (
                  s.name
                )}
              </td>
              <td>{fmtDateTime(s.createdAt)}</td>
              <td>{s.archivedAt ? "アーカイブ" : "利用中"}</td>
              <td className="row">
                {editing?.id === s.id ? (
                  <>
                    <Button onClick={() => void act(api.org.sites.update.mutate({ id: s.id, name: editing.name }).then(() => setEditing(null)))}>保存</Button>
                    <Button kind="secondary" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button kind="secondary" onClick={() => setEditing({ id: s.id, name: s.name })}>
                      名前を変更
                    </Button>
                    <Button kind="secondary" onClick={() => void act(api.org.sites.update.mutate({ id: s.id, archived: !s.archivedAt }))}>
                      {s.archivedAt ? "利用を再開" : "アーカイブ"}
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">アーカイブした拠点には登録者を追加できません(既存の登録者はそのまま残ります)。</p>
    </>
  );
}
