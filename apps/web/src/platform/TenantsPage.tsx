/** テナント一覧と開設(1-19)。人数は日次の記録(個人情報は扱わない) */
import { TENANT_STATUS_LABEL } from "@zairyu/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Card, fmtDateTime, Message } from "../ui";
import { papi, platformError, usePlatformSignOut } from "./PlatformApp";

type Tenant = Awaited<ReturnType<typeof papi.tenants.list.query>>[number];
type Plan = Awaited<ReturnType<typeof papi.plans.list.query>>[number];

export function TenantsPage() {
  const signOut = usePlatformSignOut();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ name: "", adminEmail: "", siteName: "本社", planId: "", status: "trial" as "trial" | "active" });
  const [created, setCreated] = useState<{ email: string; inviteUrl: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([papi.tenants.list.query(), papi.plans.list.query()]);
      setTenants(t);
      setPlans(p);
    } catch (e) {
      setError(platformError(e, signOut));
    }
  }, [signOut]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await papi.tenants.create.mutate({ ...form, planId: form.planId || null });
      setCreated({ email: form.adminEmail, inviteUrl: r.inviteUrl, expiresAt: r.expiresAt as unknown as string });
      setForm({ name: "", adminEmail: "", siteName: "本社", planId: "", status: "trial" });
      setError(null);
      await load();
    } catch (err) {
      setError(platformError(err, signOut));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>テナント</h1>
      <Card title="テナントを開設">
        <form onSubmit={(e) => void create(e)}>
          <div className="row wrap">
            <label className="field">
              <span>テナント名(会社名)</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
            </label>
            <label className="field">
              <span>最初の拠点名</span>
              <input value={form.siteName} onChange={(e) => setForm({ ...form, siteName: e.target.value })} required maxLength={100} />
            </label>
            <label className="field">
              <span>テナント管理者のメールアドレス</span>
              <input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required />
            </label>
            <label className="field">
              <span>プラン</span>
              <select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
                <option value="">未設定(トライアル)</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>状態</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "trial" | "active" })}>
                <option value="trial">トライアル</option>
                <option value="active">契約中</option>
              </select>
            </label>
          </div>
          <div>
            <Button type="submit" busy={busy}>
              開設して管理者を招待
            </Button>
          </div>
        </form>
        {created && (
          <div className="notice">
            <p>
              {created.email} に招待メールを送ります。届かない場合は、次のリンクを本人に安全な方法で伝えてください({fmtDateTime(created.expiresAt)} まで有効)。
            </p>
            <code>{created.inviteUrl}</code>
          </div>
        )}
      </Card>
      <Message text={error} />
      <table>
        <thead>
          <tr>
            <th>テナント</th>
            <th>状態</th>
            <th>プラン</th>
            <th className="num">直近の人数</th>
            <th>開設日</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} className={t.status === "suspended" ? "muted" : ""}>
              <td>
                <Link to={`/platform/tenants/${t.id}`}>{t.name}</Link>
              </td>
              <td className={t.status === "past_due" ? "b-expired" : ""}>{TENANT_STATUS_LABEL[t.status]}</td>
              <td>
                {t.planName ?? "未設定"}
                {t.hasOverride ? "(個別単価)" : ""}
              </td>
              <td className="num">{t.latestCount === null ? "—" : `${t.latestCount} 人(${t.latestCountDate})`}</td>
              <td>{fmtDateTime(t.createdAt).slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
