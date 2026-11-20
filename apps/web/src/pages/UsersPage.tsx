import { USER_ROLE_LABEL, USER_ROLES } from "@zairyu/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, fmtDateTime, Message } from "../ui";

type User = Awaited<ReturnType<typeof api.org.users.list.query>>[number];
type Site = Awaited<ReturnType<typeof api.org.sites.list.query>>[number];
type Role = (typeof USER_ROLES)[number];
const STATUS = { invited: "招待中", active: "有効", suspended: "停止中" } as const;

function SitePicker({ sites, value, onChange }: { sites: Site[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="row wrap">
      {sites
        .filter((s) => !s.archivedAt)
        .map((s) => (
          <label key={s.id} className="check">
            <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
            {s.name}
          </label>
        ))}
    </div>
  );
}

export function UsersPage() {
  const session = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ email: string; role: Role; siteIds: string[] }>({ email: "", role: "site_admin", siteIds: [] });
  const [issued, setIssued] = useState<{ email: string; url: string; expiresAt: string; kind?: "invite" | "reset" } | null>(null);
  const [editing, setEditing] = useState<{ id: string; role: Role; siteIds: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([api.org.users.list.query(), api.org.sites.list.query()]);
      setUsers(u);
      setSites(s);
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const siteNames = (ids: string[]) => ids.map((id) => sites.find((s) => s.id === id)?.name ?? "?").join("、") || "—";

  return (
    <>
      <h1>ユーザー</h1>
      <Card title="ユーザーを招待">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(async () => {
              const r = await api.org.users.invite.mutate(invite);
              setIssued({ email: invite.email, url: r.inviteUrl, expiresAt: r.expiresAt });
              setInvite({ email: "", role: invite.role, siteIds: [] });
            });
          }}
        >
          <div className="row">
            <input type="email" placeholder="メールアドレス" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {USER_ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={invite.role !== "tenant_admin" && invite.siteIds.length === 0}>
              招待
            </Button>
          </div>
          {invite.role !== "tenant_admin" && (
            <>
              <p className="sub">担当拠点(拠点管理者・閲覧者は担当拠点の登録者だけを扱えます)</p>
              <SitePicker sites={sites} value={invite.siteIds} onChange={(siteIds) => setInvite({ ...invite, siteIds })} />
            </>
          )}
        </form>
        {issued && (
          <div className="notice">
            <p>
              {issued.email} に{issued.kind === "reset" ? "パスワード再設定" : "招待"}のメールを送ります。メールが届かない場合は、次のリンクを本人に安全な方法で伝えてください({fmtDateTime(issued.expiresAt)} まで有効)。
            </p>
            <code className="break">{issued.url}</code>
            <Button kind="secondary" onClick={() => void navigator.clipboard.writeText(issued.url)}>
              リンクをコピー
            </Button>
          </div>
        )}
      </Card>
      <Message text={error} />
      <table>
        <thead>
          <tr>
            <th>メールアドレス</th>
            <th>ロール</th>
            <th>担当拠点</th>
            <th>状態</th>
            <th>確認コード</th>
            <th>最終ログイン</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const self = u.id === session.me?.userId;
            const isEditing = editing?.id === u.id;
            return (
              <tr key={u.id} className={u.status === "suspended" ? "muted" : ""}>
                <td>
                  {u.email}
                  {self ? "(自分)" : ""}
                </td>
                <td>
                  {isEditing ? (
                    <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })} disabled={self}>
                      {USER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {USER_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    USER_ROLE_LABEL[u.role]
                  )}
                </td>
                <td>
                  {isEditing && editing.role !== "tenant_admin" ? (
                    <SitePicker sites={sites} value={editing.siteIds} onChange={(siteIds) => setEditing({ ...editing, siteIds })} />
                  ) : u.role === "tenant_admin" ? (
                    "全拠点"
                  ) : (
                    siteNames(u.siteIds)
                  )}
                </td>
                <td>{STATUS[u.status]}</td>
                <td>{u.totpEnabled ? "設定済み" : u.role === "viewer" ? "任意" : "未設定"}</td>
                <td>{fmtDateTime(u.lastLoginAt)}</td>
                <td className="row">
                  {isEditing ? (
                    <>
                      <Button
                        onClick={() =>
                          void act(async () => {
                            await api.org.users.update.mutate({
                              userId: u.id,
                              ...(editing.role !== u.role ? { role: editing.role } : {}),
                              siteIds: editing.siteIds,
                            });
                            setEditing(null);
                          })
                        }
                      >
                        保存
                      </Button>
                      <Button kind="secondary" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button kind="secondary" onClick={() => setEditing({ id: u.id, role: u.role, siteIds: u.siteIds })}>
                        編集
                      </Button>
                      {u.status === "invited" && (
                        <Button
                          kind="secondary"
                          onClick={() =>
                            void act(async () => {
                              const r = await api.org.users.reinvite.mutate({ userId: u.id });
                              setIssued({ email: u.email, url: r.inviteUrl, expiresAt: r.expiresAt });
                            })
                          }
                        >
                          再招待
                        </Button>
                      )}
                      {u.status === "active" && (
                        <Button
                          kind="secondary"
                          onClick={() =>
                            void act(async () => {
                              const r = await api.org.users.issuePasswordReset.mutate({ userId: u.id });
                              setIssued({ email: u.email, url: r.url, expiresAt: r.expiresAt as unknown as string, kind: "reset" });
                            })
                          }
                        >
                          パスワード再設定
                        </Button>
                      )}
                      {!self && u.totpEnabled && (
                        <Button
                          kind="secondary"
                          onClick={() => {
                            if (!window.confirm(`${u.email} の認証アプリの設定をリセットしますか?スマホをなくした場合などに使います。本人は次のログインで認証アプリを設定し直します(ログイン中の端末はログアウトされます)。本人からの依頼であることを確かめてから行ってください。`)) return;
                            void act(() => api.org.users.resetTotp.mutate({ userId: u.id }));
                          }}
                        >
                          認証アプリをリセット
                        </Button>
                      )}
                      {!self && u.status !== "invited" && (
                        <Button
                          kind={u.status === "active" ? "danger" : "secondary"}
                          onClick={() => {
                            if (u.status === "active" && !window.confirm(`${u.email} を停止しますか?ログイン中の端末もすぐに使えなくなります。`)) return;
                            void act(() => api.org.users.setActive.mutate({ userId: u.id, active: u.status !== "active" }));
                          }}
                        >
                          {u.status === "active" ? "停止" : "再開"}
                        </Button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
