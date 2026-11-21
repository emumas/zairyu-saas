import { EXPIRY_BUCKET_LABEL, type ExpiryBucket } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Card, Message } from "../ui";

type Summary = Awaited<ReturnType<typeof api.dashboard.summary.query>>;

const TILES: { key: ExpiryBucket | "icUnverified" | "needsReview"; label: string; tone: string; query: string }[] = [
  { key: "expired", label: "期限切れ", tone: "danger", query: "bucket=expired" },
  { key: "within30", label: "30日以内", tone: "warn", query: "bucket=within30" },
  { key: "within90", label: "90日以内", tone: "warn", query: "bucket=within90" },
  { key: "pending", label: "更新申請中", tone: "warn", query: "bucket=pending" },
  { key: "icUnverified", label: "IC未検証", tone: "warn", query: "flag=icUnverified" },
  { key: "needsReview", label: "要確認", tone: "danger", query: "flag=needsReview" },
  { key: "noCard", label: EXPIRY_BUCKET_LABEL.noCard, tone: "warn", query: "bucket=noCard" },
];

export function DashboardPage() {
  const session = useSession();
  const sites = session.me?.sites ?? [];
  const [siteId, setSiteId] = useState("");
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.dashboard.summary.query(siteId ? { siteId } : {}).then(setS, (e) => setError(messageOf(e)));
  }, [siteId]);
  const siteQuery = siteId ? `&siteId=${siteId}` : "";
  const count = (k: (typeof TILES)[number]["key"]) => (s ? (k === "icUnverified" || k === "needsReview" ? s[k] : s.buckets[k]) : null);
  return (
    <>
      <h1>ダッシュボード</h1>
      <Message text={error} />
      <div className="row">
        <p className="sub">在籍 {s?.total ?? "-"} 人 ・ 基準日 {s?.today ?? "-"}(日本時間)</p>
        {sites.length > 1 && (
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ marginLeft: "auto" }}>
            <option value="">全拠点</option>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="tiles">
        {TILES.map((t) => (
          <Link key={t.key} to={`/persons?${t.query}${siteQuery}`} className={`tile ${count(t.key) ? `tile-${t.tone}` : ""}`}>
            <strong>{count(t.key) ?? "-"}</strong>
            <span>{t.label}</span>
          </Link>
        ))}
        {s && (
          <>
            <Link to={`/persons?work=ng${siteQuery}`} className={`tile ${s.work.ng ? "tile-danger" : ""}`}>
              <strong>{s.work.ng}</strong>
              <span>就労不可</span>
            </Link>
            <Link to={`/persons?work=check${siteQuery}`} className={`tile ${s.work.check ? "tile-warn" : ""}`}>
              <strong>{s.work.check}</strong>
              <span>就労 要確認</span>
            </Link>
            <Link to={`/persons?work=conditional${siteQuery}`} className="tile">
              <strong>{s.work.conditional}</strong>
              <span>条件付きで就労可</span>
            </Link>
          </>
        )}
        {s && s.duplicateGroups !== null && (
          <Link to="/duplicates" className={`tile ${s.duplicateGroups ? "tile-warn" : ""}`}>
            <strong>{s.duplicateGroups}</strong>
            <span>二重登録の疑い</span>
          </Link>
        )}
        {s && s.openAlerts !== null && (
          <Link to="/alerts" className={`tile ${s.openAlerts ? "tile-danger" : ""}`}>
            <strong>{s.openAlerts}</strong>
            <span>未対応のアラート</span>
          </Link>
        )}
      </div>
      <Card title="使い方">
        <p>件数を押すと、該当する登録者の一覧に移ります。カードの登録・IC の読み取りはスマホアプリで行います。</p>
      </Card>
    </>
  );
}
