/**
 * 確認履歴・監査ログの出力(1-14)。CSV はブラウザで組み立てて保存する。
 * PDF はブラウザの印刷機能で保存する(日本語フォントをサーバーに持たないため)。出力は監査ログに記録される
 */
import { addDays, jstDate, toCsv } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { downloadText } from "../download";
import { FORMAT_LABEL, METHOD_LABEL, RESULT_LABEL } from "../labels";
import { Button, Card, fmtDateTime, Message } from "../ui";

type Site = Awaited<ReturnType<typeof api.org.sites.list.query>>[number];
type VRow = Awaited<ReturnType<typeof api.reports.verifications.mutate>>["rows"][number];

const VERIFICATION_HEADER = ["確認日時", "社員番号", "氏名", "拠点", "カード様式", "確認方法", "結果", "確認者", "メモ"];
const verificationCells = (r: VRow) => [
  fmtDateTime(r.performedAt),
  r.employeeCode,
  r.personName,
  r.siteName,
  FORMAT_LABEL[r.cardFormat as keyof typeof FORMAT_LABEL] ?? r.cardFormat,
  METHOD_LABEL[r.method] ?? r.method,
  RESULT_LABEL[r.result] ?? r.result,
  r.performedByEmail ?? "",
  r.note ?? "",
];

export function ReportsPage() {
  const today = jstDate(Date.now());
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [siteId, setSiteId] = useState("");
  const [sites, setSites] = useState<Site[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printRows, setPrintRows] = useState<VRow[] | null>(null);

  useEffect(() => {
    api.org.sites.list.query().then(setSites, (e) => setError(messageOf(e)));
  }, []);

  // 印刷用の表を描いてから印刷ダイアログを開き、閉じたら消す
  useEffect(() => {
    if (!printRows) return;
    const done = () => setPrintRows(null);
    window.addEventListener("afterprint", done, { once: true });
    const t = setTimeout(() => window.print(), 100);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printRows]);

  const period = { from, to };
  const siteName = siteId ? (sites.find((s) => s.id === siteId)?.name ?? "") : "全拠点";
  const suffix = `${from.replaceAll("-", "")}-${to.replaceAll("-", "")}`;

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const fetchVerifications = async () => (await api.reports.verifications.mutate({ period, ...(siteId ? { siteId } : {}) })).rows;

  return (
    <>
      <div className="no-print">
        <h1>履歴の出力</h1>
        <Card>
          <div className="row wrap">
            <label className="field">
              <span>開始日</span>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>終了日</span>
              <input type="date" value={to} min={from} max={addDays(from, 365)} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="field">
              <span>拠点(確認履歴のみ)</span>
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">全拠点</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.archivedAt ? "(アーカイブ)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="sub">期間は 1 年以内、日付は日本時間です。出力したことは監査ログに記録されます。出力したファイルには個人情報が含まれるので、取り扱いに注意してください。</p>
        </Card>
        <Message text={error} />
        <Card title="確認履歴">
          <p className="sub">誰が・いつ・どの方法(IC 署名検証・失効照会・目視など)で在留カードを確認したかの記録です。</p>
          <div className="row">
            <Button
              busy={busy === "vcsv"}
              disabled={!!busy}
              onClick={() =>
                void run("vcsv", async () => {
                  const rows = await fetchVerifications();
                  downloadText(`verifications_${suffix}.csv`, toCsv([VERIFICATION_HEADER, ...rows.map(verificationCells)]));
                })
              }
            >
              CSV で保存
            </Button>
            <Button
              kind="secondary"
              busy={busy === "vprint"}
              disabled={!!busy}
              onClick={() => void run("vprint", async () => setPrintRows(await fetchVerifications()))}
            >
              印刷・PDF で保存
            </Button>
          </div>
        </Card>
        <Card title="監査ログ">
          <p className="sub">ログイン、登録者の変更、カード画像の閲覧、出力などの操作の記録です(値は含みません)。</p>
          <Button
            busy={busy === "acsv"}
            disabled={!!busy}
            onClick={() =>
              void run("acsv", async () => {
                const { rows } = await api.reports.auditLogs.mutate({ period });
                downloadText(
                  `audit_logs_${suffix}.csv`,
                  toCsv([
                    ["日時", "実施者", "操作", "対象の種類", "対象 ID", "詳細", "IP アドレス"],
                    ...rows.map((r) => [fmtDateTime(r.at), r.actorEmail ?? "", r.action, r.targetType ?? "", r.targetId ?? "", r.detail ? JSON.stringify(r.detail) : "", r.ip ?? ""]),
                  ]),
                );
              })
            }
          >
            CSV で保存
          </Button>
        </Card>
      </div>
      {printRows && (
        <div className="print-only">
          <h1>在留カード 確認履歴</h1>
          <p>
            期間: {from} 〜 {to}(日本時間) 拠点: {siteName} 件数: {printRows.length} 件 出力日時: {fmtDateTime(new Date())}
          </p>
          <table className="print-table">
            <thead>
              <tr>
                {VERIFICATION_HEADER.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {printRows.length === 0 && (
                <tr>
                  <td colSpan={VERIFICATION_HEADER.length}>この期間の確認履歴はありません</td>
                </tr>
              )}
              {printRows.map((r, i) => (
                <tr key={i}>
                  {verificationCells(r).map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
