import { EXPIRY_BUCKET_LABEL, EXPIRY_BUCKETS, type ExpiryBucket } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, messageOf } from "../api";
import { Button, Card, Message } from "../ui";

type List = Awaited<ReturnType<typeof api.persons.list.query>>;
const PAGE = 50;

export function PersonsPage() {
  const [params, setParams] = useSearchParams();
  const bucket = params.get("bucket") as ExpiryBucket | null;
  const flag = params.get("flag");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.persons.list
        .query({
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(bucket ? { expiryBuckets: [bucket] } : {}),
          ...(flag === "icUnverified" ? { icUnverified: true } : {}),
          ...(flag === "needsReview" ? { needsReview: true } : {}),
          sort: bucket || flag ? "expiryDate" : "employeeCode",
          limit: PAGE,
          offset,
        })
        .then(setList, (e) => setError(messageOf(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [q, bucket, flag, offset]);

  return (
    <>
      <h1>登録者</h1>
      <Card>
        <div className="row">
          <input placeholder="氏名・社員番号で検索" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          <select
            value={bucket ?? flag ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              const next = new URLSearchParams();
              if (EXPIRY_BUCKETS.includes(v as ExpiryBucket)) next.set("bucket", v);
              else if (v) next.set("flag", v);
              setParams(next);
              setOffset(0);
            }}
          >
            <option value="">すべて(在籍・退職)</option>
            {EXPIRY_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {EXPIRY_BUCKET_LABEL[b]}
              </option>
            ))}
            <option value="icUnverified">IC未検証</option>
            <option value="needsReview">要確認</option>
          </select>
        </div>
      </Card>
      <Message text={error} />
      <table>
        <thead>
          <tr>
            <th>社員番号</th>
            <th>氏名</th>
            <th>拠点</th>
            <th>期限区分</th>
            <th>期限</th>
            <th>在留資格</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {list?.items.map((p) => (
            <tr key={p.id}>
              <td>{p.employeeCode}</td>
              <td>
                <Link to={`/persons/${p.id}`}>{p.name}</Link>
              </td>
              <td>{p.siteName}</td>
              <td className={`b-${p.expiry.bucket}`}>
                {EXPIRY_BUCKET_LABEL[p.expiry.bucket]}
                {p.expiry.icUnverified ? " / IC未検証" : ""}
                {p.expiry.needsReview ? " / 要確認" : ""}
              </td>
              <td>{p.expiry.deadline ? `${p.expiry.deadline}(${p.expiry.daysLeft}日)` : "—"}</td>
              <td>{p.card?.statusOfResidence ?? "—"}</td>
              <td>{{ active: "在籍", retired: "退職", archived: "アーカイブ" }[p.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <span className="sub">
          {list ? `${list.total} 件中 ${list.total === 0 ? 0 : offset + 1}〜${Math.min(offset + PAGE, list.total)} 件` : ""}
        </span>
        <Button kind="secondary" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
          前へ
        </Button>
        <Button kind="secondary" disabled={!list || offset + PAGE >= list.total} onClick={() => setOffset(offset + PAGE)}>
          次へ
        </Button>
      </div>
    </>
  );
}
