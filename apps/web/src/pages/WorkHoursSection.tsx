/** 登録者の画面: 週28時間の確認(日ごとの時間・連続 7 日の合計・長期休業期間) */
import { addDays, formatMinutes, WEEKLY_LIMIT_MINUTES, WEEKLY_NEAR_MINUTES, WEEKLY_STATUS_LABEL } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, Field, Message } from "../ui";
import { md, WEEKLY_CLASS } from "./WorkHoursPage";

type Data = Awaited<ReturnType<typeof api.workHours.person.query>>;
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];

export function WorkHoursSection({ personId, editable }: { personId: string; editable: boolean }) {
  const session = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<{ fromDate: string; toDate: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.workHours.person
      .query({ personId })
      .then(setData)
      .catch((e: unknown) => setError(messageOf(e)));
  }, [personId, reloadKey]);

  if (!data) return error ? <Message text={error} /> : null;
  if (!data.target && data.days.length === 0) return null;

  const minutes = new Map(data.days.map((d) => [d.date, d.minutes]));
  const inBreak = (d: string) => data.breaks.some((b) => b.fromDate <= d && d <= b.toDate);
  const dates: string[] = [];
  for (let d = data.to; d >= data.from; d = addDays(d, -1)) dates.push(d);
  const windowSum = (end: string) => {
    let s = 0;
    for (let i = 0; i < 7; i++) s += minutes.get(addDays(end, -i)) ?? 0;
    return s;
  };
  const canEdit = editable && session.can("persons.write");

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
      setForm(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`週28時間の確認(${md(data.from)}〜${md(data.to)})`}>
      {!data.target && <p className="sub">今のカードは資格外活動の包括許可ではないため、週28時間の確認の対象外です(参考表示)。</p>}
      <p className={`work-level ${WEEKLY_CLASS[data.check.status]}`}>{WEEKLY_STATUS_LABEL[data.check.status]}</p>
      {data.check.maxWindow && (
        <p>
          連続 7 日の最大: {formatMinutes(data.check.maxWindow.minutes)}({md(data.check.maxWindow.from)}〜{md(data.check.maxWindow.to)})
        </p>
      )}
      {data.check.breakDaysOver.length > 0 && (
        <p className="b-expired">長期休業期間に 1 日 8 時間を超えた日: {data.check.breakDaysOver.map((d) => `${md(d.date)}(${formatMinutes(d.minutes)})`).join("、")}</p>
      )}
      <p className="sub">他の勤務先で働いた時間も 28 時間に含まれます。</p>
      <Message text={error} />

      <h3>長期休業期間</h3>
      {data.breaks.length === 0 ? (
        <p className="sub">登録はありません(夏休み・春休みなど、学則で定める期間は 1 日 8 時間まで働けます)。</p>
      ) : (
        <ul>
          {data.breaks.map((b) => (
            <li key={b.id}>
              {b.fromDate} 〜 {b.toDate}
              {b.note ? `(${b.note})` : ""}{" "}
              {canEdit && (
                <Button kind="secondary" disabled={busy} onClick={() => confirm("この長期休業期間を削除しますか?") && void run(() => api.workHours.removeBreak.mutate({ id: b.id }))}>
                  削除
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit &&
        (form ? (
          <div className="row wrap">
            <Field label="開始日" type="date" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
            <Field label="終了日" type="date" value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
            <Field label="メモ(任意)" value={form.note} maxLength={100} placeholder="夏休み" onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <Button
              disabled={busy || !form.fromDate || !form.toDate}
              onClick={() => void run(() => api.workHours.addBreak.mutate({ personId, fromDate: form.fromDate, toDate: form.toDate, note: form.note || null }))}
            >
              登録
            </Button>
            <Button kind="secondary" onClick={() => setForm(null)}>
              やめる
            </Button>
          </div>
        ) : (
          <Button kind="secondary" onClick={() => setForm({ fromDate: "", toDate: "", note: "" })}>
            長期休業期間を追加
          </Button>
        ))}

      <details>
        <summary>日ごとの労働時間</summary>
        <table>
          <thead>
            <tr>
              <th>日付</th>
              <th>労働時間</th>
              <th>この日までの 7 日</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => {
              const w = windowSum(d);
              const touchesBreak = [0, 1, 2, 3, 4, 5, 6].some((i) => inBreak(addDays(d, -i)));
              return (
                <tr key={d} className={minutes.has(d) ? "" : "muted"}>
                  <td>
                    {md(d)}({weekday(d)}){inBreak(d) && " 休業期間"}
                  </td>
                  <td>{minutes.has(d) ? formatMinutes(minutes.get(d)!) : "—"}</td>
                  {touchesBreak ? (
                    <td className="muted">{formatMinutes(w)}(休業期間を含むため対象外)</td>
                  ) : (
                    <td className={w > WEEKLY_LIMIT_MINUTES ? "b-expired" : w >= WEEKLY_NEAR_MINUTES ? "b-d30" : ""}>{formatMinutes(w)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </Card>
  );
}
