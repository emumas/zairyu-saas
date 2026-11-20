/**
 * 契約・請求(1-16)。当月の課金対象人数と見込み額、日別人数(請求の根拠)、過去の請求。
 * 課金対象は「月内の在籍登録者数の日次最大値」。契約・お支払い方法の変更は Stripe(1-17)
 */
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { Card, Message } from "../ui";

type Summary = Awaited<ReturnType<typeof api.billing.summary.query>>;

const yen = (n: number) => `${n.toLocaleString("ja-JP")} 円`;
const STATUS: Record<string, string> = { trial: "トライアル", active: "ご契約中", past_due: "お支払い確認中", suspended: "停止中" };
const PERIOD_STATUS: Record<string, string> = { open: "集計中", finalized: "確定", reported: "請求済み", paid: "お支払い済み", failed: "お支払い失敗" };

function pricingText(p: NonNullable<Summary["pricing"]>): string {
  const base = p.baseFee > 0 ? `基本料 ${yen(p.baseFee)}/月 + ` : "";
  if (p.mode === "per_unit") return `${base}登録者 1 人 ${yen(p.unitPrice)}`;
  let from = 1;
  const bands = p.tiers.map((t) => {
    const s = t.upTo === null ? `${from} 人〜 ${yen(t.unitPrice)}` : `${from}〜${t.upTo} 人 ${yen(t.unitPrice)}`;
    if (t.upTo !== null) from = t.upTo + 1;
    return s;
  });
  return `${base}登録者 1 人あたり(人数帯ごとに積み上げ): ${bands.join("、")}`;
}

export function BillingPage() {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.billing.summary.query(period ? { period } : {}).then(setS, (e) => setError(messageOf(e)));
  }, [period]);

  if (!s) return <Message text={error ?? "読み込み中…"} tone={error ? "danger" : "warn"} />;
  const isCurrent = s.period === s.today.slice(0, 7);
  const recorded = s.periods.find((p) => p.period === s.period);
  const maxDaily = Math.max(1, ...s.daily.map((d) => d.activeCount));
  const months = [...new Set([s.today.slice(0, 7), ...s.periods.map((p) => p.period)])].sort().reverse();
  // 集計中の月は上の「見込み」に出すので、一覧には確定した月だけを出す
  const closed = s.periods.filter((p) => p.status !== "open");

  return (
    <>
      <h1>契約・請求</h1>
      <Message text={error} />
      <div className="grid2">
        <Card title="ご契約">
          <dl>
            <dt>状態</dt>
            <dd>{STATUS[s.tenantStatus] ?? s.tenantStatus}</dd>
            <dt>プラン</dt>
            <dd>{s.planName ?? "未設定"}</dd>
            {s.pricing && (
              <>
                <dt>料金</dt>
                <dd>{pricingText(s.pricing)}(税抜)</dd>
              </>
            )}
            <dt>今の課金対象人数</dt>
            <dd>{s.currentCount} 人</dd>
          </dl>
          {s.pricingError && <Message text="料金の設定を確認しています。運営者にお問い合わせください。" tone="warn" />}
          <p className="sub">課金対象は、月内の在籍登録者数の日ごとの最大値です。退職・アーカイブした登録者は翌日から数えません。契約内容とお支払い方法の変更は準備中です。</p>
        </Card>
        <Card
          title={isCurrent ? `${s.period} の見込み` : `${s.period} のご請求`}
          actions={
            <select value={s.period} onChange={(e) => setPeriod(e.target.value)}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          }
        >
          <dl>
            <dt>課金対象人数</dt>
            <dd>
              {s.peakCount} 人{isCurrent ? "(月末まで変わります)" : ""}
            </dd>
            {!isCurrent && recorded && (
              <>
                <dt>金額(税抜)</dt>
                <dd>{yen(recorded.amount)}</dd>
                <dt>状態</dt>
                <dd>{PERIOD_STATUS[recorded.status] ?? recorded.status}</dd>
              </>
            )}
          </dl>
          {s.charge && (
            <table>
              <thead>
                <tr>
                  <th>項目</th>
                  <th className="num">数量</th>
                  <th className="num">単価</th>
                  <th className="num">金額</th>
                </tr>
              </thead>
              <tbody>
                {s.charge.lines.map((l) => (
                  <tr key={l.label}>
                    <td>{l.label}</td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{yen(l.unitPrice)}</td>
                    <td className="num">{yen(l.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <th colSpan={3}>合計(税抜・見込み)</th>
                  <th className="num">{yen(s.charge.total)}</th>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title={`${s.period} の日別人数`}>
        {s.daily.length === 0 ? (
          <p className="sub">まだ記録がありません(毎日 0 時過ぎに前日の人数を記録します)。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>日付</th>
                <th className="num">人数</th>
                <th style={{ width: "60%" }}></th>
              </tr>
            </thead>
            <tbody>
              {s.daily.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{d.activeCount}</td>
                  <td>
                    <div className={`bar${d.activeCount === s.peakCount ? " bar-peak" : ""}`} style={{ width: `${(d.activeCount / maxDaily) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {closed.length > 0 && (
        <Card title="これまでのご請求">
          <table>
            <thead>
              <tr>
                <th>月</th>
                <th className="num">課金対象人数</th>
                <th className="num">金額(税抜)</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((p) => (
                <tr key={p.period}>
                  <td>{p.period}</td>
                  <td className="num">{p.peakCount}</td>
                  <td className="num">{yen(p.amount)}</td>
                  <td>{PERIOD_STATUS[p.status] ?? p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
