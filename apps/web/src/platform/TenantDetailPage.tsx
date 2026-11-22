/** テナントの詳細(1-19): 契約状態・プラン・保存期間、個別単価、管理者の招待、人数と請求 */
import { TENANT_STATUS_LABEL, TENANT_STATUSES } from "@zairyu/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Button, Card, fmtDateTime, Message } from "../ui";
import { papi, platformError, usePlatformSignOut } from "./PlatformApp";
import { fromRows, intOrNull, pricingText, tiersText, TiersEditor, toRows, yen, type TierRow } from "./pricing";

type Tenant = Awaited<ReturnType<typeof papi.tenants.get.query>>;
type Plan = Awaited<ReturnType<typeof papi.plans.list.query>>[number];
const PERIOD_STATUS: Record<string, string> = { open: "集計中", finalized: "確定", reported: "請求済み", paid: "支払い済み", failed: "支払い失敗" };

export function TenantDetailPage() {
  const { id = "" } = useParams();
  const signOut = usePlatformSignOut();
  const [t, setT] = useState<Tenant | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [contract, setContract] = useState({ name: "", status: "trial" as Tenant["status"], planId: "", retentionYears: 5 });
  const [ov, setOv] = useState({ baseFee: "", mode: "none" as "none" | "per_unit" | "tiered", unitPrice: "", tiers: toRows(null) as TierRow[] });
  const [inviteEmail, setInviteEmail] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [x, p] = await Promise.all([papi.tenants.get.query({ id }), papi.plans.list.query()]);
      setT(x);
      setPlans(p);
      setContract({ name: x.name, status: x.status, planId: x.planId ?? "", retentionYears: x.retentionYears });
      const o = x.override;
      setOv({
        baseFee: o?.baseFee == null ? "" : String(o.baseFee),
        mode: o?.tiers ? "tiered" : o?.unitPrice != null ? "per_unit" : "none",
        unitPrice: o?.unitPrice == null ? "" : String(o.unitPrice),
        tiers: toRows(o?.tiers ?? null),
      });
    } catch (e) {
      setError(platformError(e, signOut));
    }
  }, [id, signOut]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (e: FormEvent | null, fn: () => Promise<string | void>) => {
    e?.preventDefault();
    try {
      const m = await fn();
      setMsg(m ?? "保存しました");
      setError(null);
      await load();
    } catch (err) {
      setMsg(null);
      setError(platformError(err, signOut));
    }
  };

  if (!t) return <Message text={error ?? "読み込み中…"} tone={error ? "danger" : "warn"} />;
  const plan = plans.find((p) => p.id === t.planId);

  return (
    <>
      <p>
        <Link to="/platform/tenants">‹ テナント一覧</Link>
        {" ・ "}
        <Link to={`/platform/logs?tenant=${t.id}`}>このテナントへの運営者の操作記録</Link>
      </p>
      <h1>{t.name}</h1>
      <Message text={error} />
      <Message text={msg} tone="ok" />
      <div className="grid2">
        <Card title="契約">
          <form
            onSubmit={(e) =>
              void act(e, async () => {
                if (contract.status === "suspended" && t.status !== "suspended" && !window.confirm("停止すると、このテナントのユーザーはログインできなくなります。停止しますか?")) return "変更しませんでした";
                await papi.tenants.update.mutate({ id, name: contract.name, status: contract.status, planId: contract.planId || null, retentionYears: contract.retentionYears });
              })
            }
          >
            <label className="field">
              <span>テナント名</span>
              <input value={contract.name} onChange={(e) => setContract({ ...contract, name: e.target.value })} required maxLength={200} />
            </label>
            <label className="field">
              <span>状態</span>
              <select value={contract.status} onChange={(e) => setContract({ ...contract, status: e.target.value as Tenant["status"] })}>
                {TENANT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TENANT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            {t.pastDueSince && <p className="sub">未払いの起点: {fmtDateTime(t.pastDueSince)}</p>}
            <label className="field">
              <span>プラン</span>
              <select value={contract.planId} onChange={(e) => setContract({ ...contract, planId: e.target.value })}>
                <option value="">未設定</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {plan && <p className="sub">{pricingText(plan)}(税抜)</p>}
            <label className="field">
              <span>退職後の保存期間(年)</span>
              <select value={contract.retentionYears} onChange={(e) => setContract({ ...contract, retentionYears: Number(e.target.value) })}>
                {[3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    {y} 年
                  </option>
                ))}
              </select>
            </label>
            <div>
              <Button type="submit">保存</Button>
            </div>
          </form>
        </Card>
        <Card title="個別単価">
          <p className="sub">入力した項目だけプランの料金を上書きします(空欄はプランの値)。{t.override ? "" : "今は上書きしていません。"}</p>
          <form
            onSubmit={(e) =>
              void act(e, async () => {
                await papi.tenants.setPriceOverride.mutate({
                  tenantId: id,
                  override: {
                    planId: null,
                    baseFee: intOrNull(ov.baseFee),
                    unitPrice: ov.mode === "per_unit" ? intOrNull(ov.unitPrice) : null,
                    tiers: ov.mode === "tiered" ? fromRows(ov.tiers) : null,
                  },
                });
              })
            }
          >
            <label className="field">
              <span>月額基本料(円・税抜)</span>
              <input type="number" min={0} placeholder="プランの値" value={ov.baseFee} onChange={(e) => setOv({ ...ov, baseFee: e.target.value })} />
            </label>
            <label className="field">
              <span>登録者の料金</span>
              <select value={ov.mode} onChange={(e) => setOv({ ...ov, mode: e.target.value as typeof ov.mode })}>
                <option value="none">プランの値</option>
                <option value="per_unit">単価を指定</option>
                <option value="tiered">人数帯を指定(段階制)</option>
              </select>
            </label>
            {ov.mode === "per_unit" && (
              <label className="field">
                <span>1 人あたりの単価(円・税抜)</span>
                <input type="number" min={0} value={ov.unitPrice} onChange={(e) => setOv({ ...ov, unitPrice: e.target.value })} required />
              </label>
            )}
            {ov.mode === "tiered" && <TiersEditor rows={ov.tiers} onChange={(tiers) => setOv({ ...ov, tiers })} />}
            {t.override && (
              <p className="sub">
                現在: {t.override.baseFee !== null ? `基本料 ${yen(t.override.baseFee)} ` : ""}
                {t.override.unitPrice !== null ? `1 人 ${yen(t.override.unitPrice)}` : ""}
                {t.override.tiers ? tiersText(t.override.tiers) : ""}
              </p>
            )}
            <div className="row">
              <Button type="submit">保存</Button>
              {t.override && (
                <Button kind="secondary" type="button" onClick={() => void act(null, async () => void (await papi.tenants.setPriceOverride.mutate({ tenantId: id, override: null })))}>
                  上書きをやめる
                </Button>
              )}
            </div>
          </form>
        </Card>
      </div>
      <Card title="テナント管理者の認証アプリをリセット">
        <p className="sub">
          唯一のテナント管理者がスマホをなくした場合などに使います。<strong>必ず電話などで本人確認をしてから</strong>行ってください。本人は次のログインで認証アプリを設定し直します。
        </p>
        <form
          className="row"
          onSubmit={(e) =>
            void act(e, async () => {
              if (!window.confirm(`${resetEmail} の認証アプリをリセットします。本人確認は済みましたか?`)) return "リセットしませんでした";
              await papi.tenants.resetAdminTotp.mutate({ tenantId: id, email: resetEmail });
              setResetEmail("");
              return "リセットしました";
            })
          }
        >
          <input type="email" placeholder="テナント管理者のメールアドレス" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} required />
          <Button type="submit" kind="danger">
            リセット
          </Button>
        </form>
      </Card>
      <Card title="テナント管理者の招待">
        <p className="sub">最初の管理者が招待を受け取れなかったときの再発行や、管理者の追加に使います。ユーザーの管理は、ふだんはテナント側で行います。</p>
        <form
          className="row"
          onSubmit={(e) =>
            void act(e, async () => {
              const r = await papi.tenants.inviteAdmin.mutate({ tenantId: id, email: inviteEmail });
              setInvite(r.inviteUrl);
              setInviteEmail("");
              return "招待を発行しました";
            })
          }
        >
          <input type="email" placeholder="メールアドレス" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
          <Button type="submit">招待</Button>
        </form>
        {invite && (
          <div className="notice">
            <p>招待メールが届かない場合は、次のリンクを本人に安全な方法で伝えてください。</p>
            <code>{invite}</code>
          </div>
        )}
      </Card>
      <div className="grid2">
        <Card title="請求">
          {t.periods.length === 0 ? (
            <p className="sub">まだありません</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>月</th>
                  <th className="num">人数</th>
                  <th className="num">金額(税抜)</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {t.periods.map((p) => (
                  <tr key={p.period}>
                    <td>{p.period}</td>
                    <td className="num">{p.peakCount}</td>
                    <td className="num">{p.status === "open" ? "—" : yen(p.amount)}</td>
                    <td>{PERIOD_STATUS[p.status] ?? p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="日別人数(直近 31 日)">
          {t.daily.length === 0 ? (
            <p className="sub">まだ記録がありません</p>
          ) : (
            <table>
              <tbody>
                {t.daily.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="num">{d.activeCount} 人</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
