import { EXPIRY_BUCKET_LABEL, EXPIRY_BUCKETS, WORK_LEVEL_LABEL, WORK_LEVELS, type ExpiryBucket, type WorkLevel } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, Message } from "../ui";

type List = Awaited<ReturnType<typeof api.persons.list.query>>;
const PAGE = 50;

export function PersonsPage() {
  const [params, setParams] = useSearchParams();
  const bucket = params.get("bucket") as ExpiryBucket | null;
  const flag = params.get("flag");
  const siteId = params.get("siteId");
  const work = params.get("work") as WorkLevel | null;
  const session = useSession();
  const sites = session.me?.sites ?? [];
  const canWrite = session.can("persons.write");
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
          ...(siteId ? { siteId } : {}),
          ...(work && WORK_LEVELS.includes(work) ? { workLevels: [work] } : {}),
          ...(flag === "icUnverified" ? { icUnverified: true } : {}),
          ...(flag === "needsReview" ? { needsReview: true } : {}),
          sort: bucket || flag ? "expiryDate" : "employeeCode",
          limit: PAGE,
          offset,
        })
        .then(setList, (e) => setError(messageOf(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [q, bucket, flag, siteId, work, offset]);

  return (
    <>
      <div className="card-head">
        <h1>登録者</h1>
        {canWrite && (
          <Link to="/persons/new" className="btn btn-primary">
            登録者を追加
          </Link>
        )}
      </div>
      <Card>
        <div className="row">
          <input placeholder="氏名・フリガナ・社員番号で検索" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          <select
            value={bucket ?? flag ?? (work ? `work:${work}` : "")}
            onChange={(e) => {
              const v = e.target.value;
              const next = new URLSearchParams();
              if (siteId) next.set("siteId", siteId);
              if (EXPIRY_BUCKETS.includes(v as ExpiryBucket)) next.set("bucket", v);
              else if (v.startsWith("work:")) next.set("work", v.slice(5));
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
            {WORK_LEVELS.map((l) => (
              <option key={l} value={`work:${l}`}>
                就労可否: {WORK_LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
          {sites.length > 1 && (
            <select
              value={siteId ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                if (e.target.value) next.set("siteId", e.target.value);
                else next.delete("siteId");
                setParams(next);
                setOffset(0);
              }}
            >
              <option value="">全拠点</option>
              {sites.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
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
            <th>就労可否</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {list?.items.map((p) => (
            <tr key={p.id}>
              <td>{p.employeeCode}</td>
              <td>
                <Link to={`/persons/${p.id}`}>{p.name}</Link>
                {p.nameKana && <div className="sub">{p.nameKana}</div>}
              </td>
              <td>{p.siteName}</td>
              <td className={`b-${p.expiry.bucket}`}>
                {EXPIRY_BUCKET_LABEL[p.expiry.bucket]}
                {p.expiry.icUnverified ? " / IC未検証" : ""}
                {p.expiry.needsReview ? " / 要確認" : ""}
              </td>
              <td>{p.expiry.deadline ? `${p.expiry.deadline}(${p.expiry.daysLeft}日)` : "—"}</td>
              <td>{p.card?.statusOfResidence ?? "—"}</td>
              <td className={`w-${p.work.level}`}>{WORK_LEVEL_LABEL[p.work.level]}</td>
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
