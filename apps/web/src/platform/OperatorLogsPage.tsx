/** 運営者の操作記録(platform_audit_logs)の閲覧と CSV 出力。出力したことも記録される */
import { addDays, jstDate, toCsv } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { downloadText } from "../download";
import { Button, Card, fmtDateTime, Message } from "../ui";
import { papi, platformError, usePlatformSignOut } from "./PlatformApp";

type Row = Awaited<ReturnType<typeof papi.auditLogs.list.query>>["rows"][number];
type Operator = Awaited<ReturnType<typeof papi.auditLogs.operators.query>>[number];
type Tenant = Awaited<ReturnType<typeof papi.tenants.list.query>>[number];

export const OPERATOR_ACTION_LABEL: Record<string, string> = {
  "operator.create": "運営者アカウントの作成(CLI)",
  "operator.totp_reset": "運営者の認証アプリの再設定(CLI)",
  "operator.login": "ログイン",
  "operator.login_failed": "ログイン失敗(パスワード)",
  "operator.totp_failed": "ログイン失敗(認証コード)",
  "operator.login_rejected": "ログイン拒否(停止・ロック中)",
  "tenant.create": "テナントの開設",
  "tenant.update": "テナントの変更",
  "tenant.invite_admin": "テナント管理者の招待",
  "tenant.reset_admin_totp": "テナント管理者の認証アプリの再設定",
  "price_override.set": "個別単価の設定",
  "price_override.clear": "個別単価の解除",
  "plan.create": "プランの作成",
  "plan.update": "プランの変更",
  "platform_audit_log.export": "操作記録の出力",
  "platform_audit_log.purge": "保存期間切れの操作記録の削除(自動)",
};
const ACTION_FILTERS = [
  ["", "すべて"],
  ["operator.", "ログイン関係"],
  ["tenant.", "テナント"],
  ["price_override.", "個別単価"],
  ["plan.", "プラン"],
  ["platform_audit_log.", "操作記録の出力・削除"],
] as const;
const actionLabel = (a: string) => OPERATOR_ACTION_LABEL[a] ?? a;
const detailText = (d: unknown) => (d === null || d === undefined ? "" : JSON.stringify(d));

export function OperatorLogsPage() {
  const signOut = usePlatformSignOut();
  const [params] = useSearchParams();
  const today = jstDate(Date.now());
  const [filter, setFilter] = useState({ from: addDays(today, -30), to: today, operatorId: "", tenantId: params.get("tenant") ?? "", action: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    () => ({
      period: { from: filter.from, to: filter.to },
      ...(filter.operatorId ? { operatorId: filter.operatorId } : {}),
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
    }),
    [filter],
  );

  const load = useCallback(
    async (beforeId?: number) => {
      setBusy(true);
      try {
        const r = await papi.auditLogs.list.query({ ...query(), ...(beforeId ? { beforeId } : {}) });
        setRows((cur) => (beforeId ? [...cur, ...r.rows] : r.rows));
        setNext(r.nextBeforeId);
        setError(null);
      } catch (e) {
        setError(platformError(e, signOut));
      } finally {
        setBusy(false);
      }
    },
    [query, signOut],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    Promise.all([papi.auditLogs.operators.query(), papi.tenants.list.query()]).then(
      ([o, t]) => {
        setOperators(o);
        setTenants(t);
      },
      (e: unknown) => setError(platformError(e, signOut)),
    );
  }, [signOut]);

  async function exportCsv() {
    setBusy(true);
    try {
      const r = await papi.auditLogs.export.mutate(query());
      downloadText(
        `operator_logs_${filter.from.replaceAll("-", "")}_${filter.to.replaceAll("-", "")}.csv`,
        toCsv([
          ["日時", "運営者", "操作", "操作の名前", "対象の種類", "対象", "対象 ID", "詳細", "IP アドレス"],
          ...r.rows.map((x) => [fmtDateTime(x.at), x.operatorEmail ?? "", actionLabel(x.action), x.action, x.targetType ?? "", x.targetName ?? "", x.targetId ?? "", detailText(x.detail), x.ip ?? ""]),
        ]),
      );
      await load();
    } catch (e) {
      setError(platformError(e, signOut));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof filter) => (e: { target: { value: string } }) => setFilter((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <h1>運営者の操作記録</h1>
      <Card>
        <div className="row wrap">
          <label className="field">
            <span>開始日</span>
            <input type="date" value={filter.from} onChange={set("from")} />
          </label>
          <label className="field">
            <span>終了日</span>
            <input type="date" value={filter.to} onChange={set("to")} />
          </label>
          <label className="field">
            <span>運営者</span>
            <select value={filter.operatorId} onChange={set("operatorId")}>
              <option value="">すべて</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.email}
                  {o.disabled ? "(停止)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>テナント</span>
            <select value={filter.tenantId} onChange={set("tenantId")}>
              <option value="">すべて</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>操作</span>
            <select value={filter.action} onChange={set("action")}>
              {ACTION_FILTERS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="sub">期間は 1 年以内、日付は日本時間です。記録は追記専用で、変更・削除はできません。CSV で保存したことも記録されます。</p>
        <Button kind="secondary" busy={busy} onClick={() => void exportCsv()}>
          CSV で保存
        </Button>
      </Card>
      <Message text={error} />
      <Card title={`${rows.length} 件${next ? "(続きあり)" : ""}`}>
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>運営者</th>
              <th>操作</th>
              <th>対象</th>
              <th>詳細</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.at)}</td>
                <td>{r.operatorEmail ?? "—"}</td>
                <td title={r.action}>{actionLabel(r.action)}</td>
                <td>
                  {r.targetType === "tenant" && r.targetId ? (
                    <Link to={`/platform/tenants/${r.targetId}`}>{r.targetName ?? r.targetId}</Link>
                  ) : (
                    (r.targetName ?? r.targetId ?? "")
                  )}
                </td>
                <td className="sub" style={{ wordBreak: "break-all" }}>
                  {detailText(r.detail)}
                </td>
                <td>{r.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !busy && <p className="sub">条件に合う記録はありません。</p>}
        {next && (
          <Button kind="secondary" busy={busy} onClick={() => void load(next)}>
            さらに表示
          </Button>
        )}
      </Card>
    </>
  );
}
