import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, messageOf } from "../api";
import { Button, Card, fmtDateTime, Message } from "../ui";

type Site = Awaited<ReturnType<typeof api.org.sites.list.query>>[number];

export function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  /** 届出に書く事業所の情報を編集中の拠点 */
  const [detail, setDetail] = useState<{ id: string; officialName: string; address: string; phone: string; insuranceOfficeNumber: string } | null>(null);
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
                    <Button
                      kind="secondary"
                      onClick={() =>
                        setDetail({ id: s.id, officialName: s.officialName ?? "", address: s.address ?? "", phone: s.phone ?? "", insuranceOfficeNumber: s.insuranceOfficeNumber ?? "" })
                      }
                    >
                      届出用の情報{s.address && s.phone ? "" : "(未入力)"}
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
      {detail && (
        <Card title={`届出用の事業所の情報: ${sites.find((x) => x.id === detail.id)?.name ?? ""}`}>
          <p className="sub">外国人雇用状況の届出に書く、雇入れ・離職に係る事業所の情報です。</p>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act(api.org.sites.update.mutate(detail).then(() => setDetail(null)));
            }}
          >
            <label className="field">
              <span>事業所の正式名称(空欄なら拠点名)</span>
              <input value={detail.officialName} onChange={(e) => setDetail({ ...detail, officialName: e.target.value })} maxLength={100} />
            </label>
            <label className="field">
              <span>所在地</span>
              <input value={detail.address} onChange={(e) => setDetail({ ...detail, address: e.target.value })} maxLength={200} />
            </label>
            <label className="field">
              <span>電話番号</span>
              <input value={detail.phone} onChange={(e) => setDetail({ ...detail, phone: e.target.value })} maxLength={20} />
            </label>
            <label className="field">
              <span>雇用保険適用事業所番号(あれば。例: 1234-567890-1)</span>
              <input value={detail.insuranceOfficeNumber} onChange={(e) => setDetail({ ...detail, insuranceOfficeNumber: e.target.value })} maxLength={15} />
            </label>
            <div className="row">
              <Button kind="secondary" type="button" onClick={() => setDetail(null)}>
                やめる
              </Button>
              <Button type="submit">保存</Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
