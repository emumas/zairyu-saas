/**
 * 週28時間の確認(フェーズ2)。勤怠 CSV の取り込みと、資格外活動(包括許可)の人の一覧
 */
import { addDays, formatMinutes, parseCsv, toCsv, WEEKLY_STATUS_LABEL, workRowsFromCsv, type WorkCsvRow } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { downloadText, readCsvFile } from "../download";
import { useSession } from "../session";
import { CsvExample } from "../CsvExample";
import { Button, Card, Message } from "../ui";

type List = Awaited<ReturnType<typeof api.workHours.list.query>>;
type ImportResult = Awaited<ReturnType<typeof api.workHours.importDays.mutate>>;
export const WEEKLY_CLASS = { over: "b-expired", near: "b-d30", ok: "", noData: "muted" } as const;

const TEMPLATE = [
  ["社員番号", "日付", "労働時間", "出勤", "退勤", "休憩"],
  ["E0001", "2026/04/01", "4:30", "", "", ""],
  ["E0001", "2026/04/02", "", "18:00", "22:30", "30"],
];

export const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function ImportCard({ onImported }: { onImported: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkCsvRow[] | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const valid = (rows ?? []).filter((r) => r.errors.length === 0 && r.date !== null && r.minutes !== null);
  const send = (dryRun: boolean) =>
    api.workHours.importDays.mutate({ dryRun, rows: valid.map((r) => ({ line: r.line, employeeCode: r.employeeCode, date: r.date!, minutes: r.minutes! })) });

  async function onFile(file: File | undefined) {
    setRows(null);
    setResult(null);
    setError(null);
    setDone(null);
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const parsed = workRowsFromCsv(parseCsv(await readCsvFile(file)));
      if ("error" in parsed) return setError(parsed.error);
      setRows(parsed.rows);
      const ok = parsed.rows.filter((r) => r.errors.length === 0);
      if (ok.length > 0) {
        setResult(
          await api.workHours.importDays.mutate({ dryRun: true, rows: ok.map((r) => ({ line: r.line, employeeCode: r.employeeCode, date: r.date!, minutes: r.minutes! })) }),
        );
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const r = await send(false);
      const skipped = r.errors.length + (rows ?? []).filter((x) => x.errors.length > 0).length;
      setRows(null);
      setResult(null);
      setDone(`取り込みました(${r.persons} 人・${r.days} 日分${skipped ? `・エラーで除外 ${skipped} 行` : ""})。`);
      onImported();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const errors = [...(rows ?? []).filter((r) => r.errors.length > 0).map((r) => ({ line: r.line, errors: r.errors })), ...(result?.errors ?? [])].sort((a, b) => a.line - b.line);
  return (
    <Card title="勤怠 CSV の取り込み">
      <p className="sub">
        社員番号・日付と、労働時間(6:30・6.5・390分)または 出勤・退勤・休憩 の列がある CSV を読み込みます。同じ日の行が複数あれば合計し、登録済みの日は上書きします。
      </p>
      <div className="row wrap">
        <label className="btn btn-primary">
          CSV を選ぶ
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <Button kind="secondary" onClick={() => downloadText("work_hours_template.csv", toCsv(TEMPLATE))}>
          ひな形をダウンロード
        </Button>
        {fileName && <span className="sub">{fileName}</span>}
      </div>
      <CsvExample
        columns={[
          { header: "社員番号", required: true, note: "登録済みの社員番号" },
          { header: "日付", required: true, note: "2026/04/01 または 2026-04-01" },
          { header: "労働時間", note: "6:30・6.5・390分・6時間30分" },
          { header: "出勤", note: "9:00 の形(労働時間が空欄のとき)" },
          { header: "退勤", note: "17:30 の形。日をまたぐ勤務も可" },
          { header: "休憩", note: "分(30)か 1:00 の形" },
        ]}
        rows={[
          ["E0001", "2026/04/01", "4:30", "", "", ""],
          ["E0001", "2026/04/02", "", "18:00", "22:30", "30"],
          ["E0002", "2026/04/02", "6.5", "", "", ""],
        ]}
        notes={[
          "労働時間の列か、出勤・退勤(・休憩)の列のどちらかで書きます。両方あれば労働時間を使います。",
          "同じ人・同じ日の行が複数あれば合計します(1 日 2 回の勤務など)。取り込み済みの日は上書きします。",
          "労働時間も出勤・退勤も空欄の行は、その日を 0 時間(休み)として扱います。",
        ]}
      />
      <Message text={error} />
      <Message text={done} tone="ok" />
      {busy && <Message text="処理中…" tone="warn" />}
      {rows && (
        <>
          <p>
            {result ? `${result.persons} 人・${result.days} 日分を取り込めます。` : "取り込める行がありません。"}
            {errors.length > 0 && `エラー ${errors.length} 行。`}
            {result && result.notTargetRows > 0 && `(週28時間の確認の対象でない人の行が ${result.notTargetRows} 行あります。保存はします)`}
          </p>
          {errors.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>行</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {errors.slice(0, 100).map((e, i) => (
                  <tr key={i}>
                    <td>{e.line}</td>
                    <td className="b-expired">{e.errors.join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row">
            <Button kind="secondary" onClick={() => void onFile(undefined)} disabled={busy}>
              やめる
            </Button>
            <Button onClick={() => void commit()} disabled={busy || !result || result.days === 0}>
              {errors.length ? `エラーの ${errors.length} 行を除いて取り込む` : "取り込む"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function WorkHoursPage() {
  const session = useSession();
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.workHours.list
      .query(period ? { period } : {})
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(messageOf(e)));
  }, [period, reloadKey]);

  const count = (s: keyof typeof WEEKLY_STATUS_LABEL) => data?.items.filter((i) => i.check.status === s).length ?? 0;
  // 入力中の期間(読み込み前でも、直前に選んだ値を使う)
  const cur = period ?? (data ? { from: data.from, to: data.to } : null);
  const shift = (days: number) => cur && setPeriod({ from: addDays(cur.from, days), to: addDays(cur.to, days) });
  return (
    <>
      <h1>週28時間の確認</h1>
      <Card>
        <p>
          資格外活動許可(包括許可)で働く人は、<strong>どの曜日から数えても連続する 7 日で 28 時間以内</strong>
          にする必要があります。取り込んだ勤怠から、期間内に終わるすべての 7 日の合計を確かめます(24 時間以上で注意)。
        </p>
        <p className="sub">
          他の勤務先で働いた時間も 28 時間に含まれます。本人に掛け持ちの有無を確認してください。学則で定める長期休業期間は 1 日 8 時間以内です(登録者の画面で期間を登録すると、その期間を含む 7 日は 28 時間の確認から外し、1 日 8 時間を確かめます)。
        </p>
      </Card>
      {session.can("imports.run") && <ImportCard onImported={() => setReloadKey((k) => k + 1)} />}
      <Message text={error} />
      {data && cur && (
        <Card
          title={`対象者 ${data.items.length} 人(超過 ${count("over")}・注意 ${count("near")}・データなし ${count("noData")})`}
          actions={
            <div className="row wrap">
              <Button kind="secondary" onClick={() => shift(-28)}>
                ← 4 週前
              </Button>
              <input type="date" value={cur.from} onChange={(e) => e.target.value && setPeriod({ from: e.target.value, to: cur.to < e.target.value ? e.target.value : cur.to })} />
              〜
              <input type="date" value={cur.to} onChange={(e) => e.target.value && setPeriod({ from: cur.from > e.target.value ? e.target.value : cur.from, to: e.target.value })} />
              <Button kind="secondary" onClick={() => shift(28)}>
                4 週後 →
              </Button>
            </div>
          }
        >
          {data.items.length === 0 ? (
            <p className="sub">資格外活動許可(包括許可)の在籍者はいません。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>社員番号</th>
                  <th>氏名</th>
                  <th>拠点</th>
                  <th>判定</th>
                  <th>最も多い 7 日</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.employeeCode}</td>
                    <td>
                      <Link to={`/persons/${i.id}`}>{i.name}</Link>
                    </td>
                    <td>{i.siteName}</td>
                    <td className={WEEKLY_CLASS[i.check.status]}>
                      {WEEKLY_STATUS_LABEL[i.check.status]}
                      {i.check.breakDaysOver.length > 0 && `(長期休業中に 8 時間超 ${i.check.breakDaysOver.length} 日)`}
                    </td>
                    <td>{i.check.maxWindow ? `${formatMinutes(i.check.maxWindow.minutes)}(${md(i.check.maxWindow.from)}〜${md(i.check.maxWindow.to)})` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}
