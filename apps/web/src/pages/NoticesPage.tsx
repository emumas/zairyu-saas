/**
 * 外国人雇用状況の届出(第1段階): 期限の管理・記入内容の一覧・提出の記録。
 * 事業主が自分で提出するための補助(提出の代行はしない)。在留カード番号の全桁の表示は監査ログに残る
 */
import {
  jstDate,
  NOTICE_KIND_LABEL,
  NOTICE_METHOD_LABEL,
  NOTICE_METHODS,
  NOTICE_STATUS_LABEL,
  toCsv,
  type NoticeMethod,
} from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { downloadText } from "../download";
import { Button, Card, Message } from "../ui";

type Item = Awaited<ReturnType<typeof api.notices.list.query>>["items"][number];
type Detail = Awaited<ReturnType<typeof api.notices.detail.query>>;
type Filter = "pending" | "submitted" | "not_required" | "all";
const FILTERS: [Filter, string][] = [
  ["pending", "未提出"],
  ["submitted", "提出済み"],
  ["not_required", "届出不要"],
  ["all", "すべて"],
];

const dueText = (i: Item) =>
  i.status !== "pending"
    ? i.dueDate
    : i.daysLeft < 0
      ? `${i.dueDate}(${-i.daysLeft} 日超過)`
      : `${i.dueDate}(あと ${i.daysLeft} 日)`;
const dueClass = (i: Item) =>
  i.status !== "pending"
    ? ""
    : i.daysLeft < 0
      ? "b-expired"
      : i.daysLeft <= 7
        ? "b-d30"
        : "";

function DetailCard({
  item,
  onChanged,
  onClose,
}: {
  item: Item;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [number, setNumber] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [form, setForm] = useState({
    submittedOn: jstDate(Date.now()),
    method: "hellowork_internet" as NoticeMethod,
    receiptNo: "",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = {
    personId: item.personId,
    kind: item.kind,
    eventDate: item.eventDate,
  };

  useEffect(() => {
    setNumber(null);
    api.notices.detail
      .query(key)
      .then(setD, (e: unknown) => setError(messageOf(e)));
  }, [item.personId, item.kind, item.eventDate]);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
    } catch {
      setCopied(null);
    }
  }
  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function reveal() {
    if (!d?.cardId) return;
    try {
      setNumber(
        (await api.cards.revealCardNumber.mutate({ cardId: d.cardId }))
          .cardNumber,
      );
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const fields = d?.fields ?? [];
  return (
    <Card
      title={`記入内容: ${item.name}(${NOTICE_KIND_LABEL[item.kind]} ${item.eventDate})`}
      actions={
        <div className="row no-print">
          <Button kind="secondary" onClick={() => window.print()} disabled={!d}>
            印刷
          </Button>
          <Button kind="secondary" onClick={onClose}>
            閉じる
          </Button>
        </div>
      }
    >
      <p>
        書式: <b>{item.form}</b> ／ 提出期限:{" "}
        <span className={dueClass(item)}>{dueText(item)}</span>
      </p>
      {item.insured === null && (
        <Message
          text="雇用保険の加入が未設定です。登録者の画面で設定すると、書式と期限が決まります(今は早いほうの期限を表示しています)。"
          tone="warn"
        />
      )}
      {item.missing.length > 0 && (
        <Message
          text={`空欄の項目: ${item.missing.join("・")}。登録者・カード記載事項・拠点・設定の画面で入力してください。`}
          tone="warn"
        />
      )}
      <Message text={error} />
      <div className="print-area">
        <table>
          <tbody>
            {fields.map((f) => {
              const value = f.secret ? (number ?? f.value) : f.value;
              return (
                <tr key={f.label}>
                  <th style={{ width: "32%" }}>{f.label}</th>
                  <td>
                    {value ?? (
                      <span className={f.optional ? "sub" : "b-d30"}>
                        {f.optional ? "(該当なし)" : "未入力"}
                      </span>
                    )}{" "}
                    <span className="no-print">
                      {f.secret && value && !number && d?.cardId && (
                        <Button kind="secondary" onClick={() => void reveal()}>
                          全桁を表示
                        </Button>
                      )}
                      {value && (!f.secret || number) && (
                        <Button
                          kind="secondary"
                          onClick={() => void copy(f.label, value)}
                        >
                          {copied === f.label ? "コピーしました" : "コピー"}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sub no-print">
        在留カード番号の全桁の表示は監査ログに記録されます。雇用保険の届出の、外国人の欄以外の項目(被保険者番号など)は、給与・労務ソフトなどで作成してください。
      </p>

      <h3 className="no-print">提出の記録</h3>
      <div className="no-print">
        {item.status !== "pending" ? (
          <>
            <p>
              {NOTICE_STATUS_LABEL[item.status]}
              {item.record?.submittedOn
                ? `(${item.record.submittedOn}・${NOTICE_METHOD_LABEL[item.record.method as NoticeMethod] ?? item.record.method ?? ""}${item.record.receiptNo ? `・受付番号 ${item.record.receiptNo}` : ""})`
                : ""}
              {item.record?.note ? ` メモ: ${item.record.note}` : ""}
              {item.autoReason ? `(${item.autoReason})` : ""}
            </p>
            {item.record && (
              <Button
                kind="secondary"
                busy={busy}
                onClick={() =>
                  confirm("記録を取り消して未提出に戻しますか?") &&
                  void run(() => api.notices.clear.mutate(key))
                }
              >
                記録を取り消す
              </Button>
            )}
          </>
        ) : (
          <div className="row wrap">
            <label className="field">
              <span>提出日</span>
              <input
                type="date"
                value={form.submittedOn}
                onChange={(e) =>
                  setForm({ ...form, submittedOn: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>提出の方法</span>
              <select
                value={form.method}
                onChange={(e) =>
                  setForm({ ...form, method: e.target.value as NoticeMethod })
                }
              >
                {NOTICE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {NOTICE_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>受付番号(任意)</span>
              <input
                value={form.receiptNo}
                onChange={(e) =>
                  setForm({ ...form, receiptNo: e.target.value })
                }
                maxLength={50}
              />
            </label>
            <label className="field">
              <span>メモ(届出不要のときは理由)</span>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                maxLength={200}
              />
            </label>
            <Button
              busy={busy}
              onClick={() =>
                void run(() =>
                  api.notices.record.mutate({
                    ...key,
                    status: "submitted",
                    submittedOn: form.submittedOn,
                    method: form.method,
                    receiptNo: form.receiptNo || null,
                    note: form.note || null,
                  }),
                )
              }
            >
              提出済みにする
            </Button>
            <Button
              kind="secondary"
              busy={busy}
              disabled={!form.note.trim()}
              onClick={() =>
                void run(() =>
                  api.notices.record.mutate({
                    ...key,
                    status: "not_required",
                    note: form.note,
                  }),
                )
              }
            >
              届出不要にする
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function NoticesPage() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [data, setData] = useState<{ from: string; items: Item[] } | null>(
    null,
  );
  const [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.notices.list.query({ status: filter }).then(
      (d) => {
        setData(d);
        setError(null);
        // 開いている届出の状態を新しくする(一覧から消えたら閉じる)
        setSelected((cur) =>
          cur
            ? (d.items.find(
                (i) =>
                  i.personId === cur.personId &&
                  i.kind === cur.kind &&
                  i.eventDate === cur.eventDate,
              ) ?? null)
            : null,
        );
      },
      (e: unknown) => setError(messageOf(e)),
    );
  }, [filter]);
  useEffect(() => load(), [load]);

  function exportCsv() {
    if (!data) return;
    downloadText(
      `notices_${filter}_${jstDate(Date.now()).replaceAll("-", "")}.csv`,
      toCsv([
        [
          "提出期限",
          "社員番号",
          "氏名",
          "拠点",
          "種類",
          "日付",
          "書式",
          "状態",
          "提出日",
          "提出の方法",
          "受付番号",
          "空欄の項目",
        ],
        ...data.items.map((i) => [
          i.dueDate,
          i.employeeCode,
          i.name,
          i.siteName,
          NOTICE_KIND_LABEL[i.kind],
          i.eventDate,
          i.form,
          NOTICE_STATUS_LABEL[i.status],
          i.record?.submittedOn ?? "",
          i.record?.method
            ? (NOTICE_METHOD_LABEL[i.record.method as NoticeMethod] ??
              i.record.method)
            : "",
          i.record?.receiptNo ?? "",
          i.missing.join("・"),
        ]),
      ]),
    );
  }

  return (
    <>
      <h1 className="no-print">外国人雇用状況の届出</h1>
      <div className="no-print">
        <Card>
          <div className="no-print">
            <p>
              外国人を雇い入れた・離職したときは、ハローワークへの届出が必要です(特別永住者は対象外)。入社日・退職日から届出と提出期限を自動で出します。
            </p>
            <ul className="sub">
              <li>
                雇用保険の被保険者:
                雇用保険被保険者資格取得届・資格喪失届の外国人の欄で届け出ます(雇入れは翌月10日まで、離職は離職日の翌々日から10日以内)
              </li>
              <li>
                被保険者でない人:
                外国人雇用状況届出書(様式第3号)で届け出ます(雇入れ・離職とも翌月末日まで)
              </li>
              <li>
                期限は目安です。ハローワークの案内で確かめてください。このアプリは事業主が自分で提出するための補助で、提出の代行はしません
              </li>
              <li>
                事業所の所在地などは <Link to="/org/sites">拠点</Link>
                、事業主の情報は <Link to="/settings">設定</Link> で入力します。
                {data ? `${data.from} 以後の雇入れ・離職が対象です。` : ""}
              </li>
            </ul>
          </div>
        </Card>
        <Message text={error} />
        {data && (
          <Card
            title={`${FILTERS.find(([f]) => f === filter)![1]} ${data.items.length} 件`}
            actions={
              <div className="row wrap no-print">
                {FILTERS.map(([f, label]) => (
                  <Button
                    key={f}
                    kind={f === filter ? "primary" : "secondary"}
                    onClick={() => setFilter(f)}
                  >
                    {label}
                  </Button>
                ))}
                <Button
                  kind="secondary"
                  onClick={exportCsv}
                  disabled={data.items.length === 0}
                >
                  CSV で保存
                </Button>
              </div>
            }
          >
            {data.items.length === 0 ? (
              <p className="sub">該当する届出はありません。</p>
            ) : (
              <table className="no-print">
                <thead>
                  <tr>
                    <th>提出期限</th>
                    <th>社員番号</th>
                    <th>氏名</th>
                    <th>拠点</th>
                    <th>種類</th>
                    <th>日付</th>
                    <th>書式</th>
                    <th>状態</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={`${i.personId}${i.kind}${i.eventDate}`}>
                      <td className={dueClass(i)}>{dueText(i)}</td>
                      <td>{i.employeeCode}</td>
                      <td>
                        <Link to={`/persons/${i.personId}`}>{i.name}</Link>
                      </td>
                      <td>{i.siteName}</td>
                      <td>{NOTICE_KIND_LABEL[i.kind]}</td>
                      <td>{i.eventDate}</td>
                      <td>{i.form}</td>
                      <td>
                        {NOTICE_STATUS_LABEL[i.status]}
                        {i.missing.length > 0 && i.status === "pending" && (
                          <div className="b-d30">
                            空欄 {i.missing.length} 項目
                          </div>
                        )}
                      </td>
                      <td>
                        <Button kind="secondary" onClick={() => setSelected(i)}>
                          記入内容・記録
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
      {selected && (
        <DetailCard
          item={selected}
          onChanged={load}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
