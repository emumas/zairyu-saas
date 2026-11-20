/**
 * ホーム(1-12): 期限区分の件数(ダッシュボード)と登録者の検索。
 * - 件数を押すとその区分で絞り込む。拠点が複数あれば拠点で切り替えられる
 * - 引っ張って更新。登録者の詳細から戻っても、絞り込み・検索・拠点はそのまま
 */
import { EXPIRY_BUCKET_LABEL, RESTRICTED_MESSAGE, type ExpiryBucket } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Card, color, Field, Message, Screen } from "../ui/kit";
import { bucketTone } from "./format";

type Summary = Awaited<ReturnType<typeof api.dashboard.summary.query>>;
type PersonItem = Awaited<ReturnType<typeof api.persons.list.query>>["items"][number];
type Flag = "icUnverified" | "needsReview";
type Tile = { bucket?: ExpiryBucket; flag?: Flag; label: string; tone: "danger" | "warn" };

const TILES: Tile[] = [
  { bucket: "expired", label: "期限切れ", tone: "danger" },
  { bucket: "within30", label: "30日以内", tone: "danger" },
  { bucket: "within90", label: "90日以内", tone: "warn" },
  { bucket: "pending", label: "更新申請中", tone: "warn" },
  { flag: "needsReview", label: "要確認", tone: "danger" },
  { flag: "icUnverified", label: "IC未検証", tone: "warn" },
  { bucket: "noCard", label: EXPIRY_BUCKET_LABEL.noCard, tone: "warn" },
];
const PAGE = 50;

/** 画面を離れても絞り込みを覚えておく(アプリを閉じるまで。端末には保存しない) */
let remembered: { q: string; tile: Tile | null; siteId: string | null } = { q: "", tile: null, siteId: null };

export function HomeScreen({
  onOpenPerson,
  onOpenPoc,
  onCreatePerson,
  onOpenAlerts,
}: {
  onOpenPerson: (id: string) => void;
  onOpenPoc: () => void;
  onCreatePerson: () => void;
  onOpenAlerts: () => void;
}) {
  const session = useSession();
  const me = session.state.status === "signedIn" ? session.state.me : null;
  // 未払い時の制御(1-18)。アプリには料金・支払いの案内を出さない(App Store 3.1.3。契約は Web だけ)
  const billing = me?.billing ?? null;
  const sites = me?.sites ?? [];
  const [q, setQ] = useState(remembered.q);
  const [tile, setTile] = useState<Tile | null>(remembered.tile);
  const [siteId, setSiteId] = useState<string | null>(remembered.siteId && sites.some((s) => s.id === remembered.siteId) ? remembered.siteId : null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [items, setItems] = useState<PersonItem[]>([]);
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    remembered = { q, tile, siteId };
  }, [q, tile, siteId]);

  const listQuery = useCallback(
    (offset: number) =>
      api.persons.list.query({
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(siteId ? { siteId } : {}),
        ...(tile?.bucket ? { expiryBuckets: [tile.bucket] } : {}),
        ...(tile?.flag === "icUnverified" ? { icUnverified: true } : {}),
        ...(tile?.flag === "needsReview" ? { needsReview: true } : {}),
        sort: tile ? "expiryDate" : "employeeCode",
        limit: PAGE,
        offset,
      }),
    [q, tile, siteId],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, list] = await Promise.all([api.dashboard.summary.query(siteId ? { siteId } : {}), listQuery(0)]);
      setSummary(s);
      setItems(list.items);
      setTotal(list.total);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [siteId, listQuery]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function more() {
    setLoadingMore(true);
    try {
      const list = await listQuery(items.length);
      setItems((cur) => [...cur, ...list.items]);
      setTotal(list.total);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const count = (t: Tile) => (summary ? (t.bucket ? summary.buckets[t.bucket] : summary[t.flag!]) : null);

  return (
    <Screen
      title="在留カード管理"
      right={<Text style={{ color: color.sub }} onPress={() => void session.logout()}>ログアウト</Text>}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    >
      <Text style={{ color: color.sub }}>{me?.email}</Text>
      {sites.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {[{ id: null as string | null, name: "全拠点" }, ...sites].map((s) => (
            <Pressable key={s.id ?? "all"} style={[styles.chip, siteId === s.id && styles.chipOn]} onPress={() => setSiteId(s.id)}>
              <Text style={[styles.chipText, siteId === s.id && { color: color.primary, fontWeight: "700" }]}>{s.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={styles.tiles}>
        <Pressable style={[styles.tile, !tile && styles.tileOn]} onPress={() => setTile(null)}>
          <Text style={styles.tileCount}>{summary?.total ?? "-"}</Text>
          <Text style={styles.tileLabel}>在籍(全員)</Text>
        </Pressable>
        {TILES.map((t) => {
          const n = count(t);
          const active = tile?.label === t.label;
          return (
            <Pressable key={t.label} style={[styles.tile, active && styles.tileOn]} onPress={() => setTile(active ? null : t)}>
              <Text style={[styles.tileCount, n ? { color: color[t.tone] } : null]}>{n ?? "-"}</Text>
              <Text style={styles.tileLabel}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: color.sub, fontSize: 12 }}>基準日 {summary?.today ?? "-"}(日本時間)。件数を押すと絞り込みます。下に引っ張ると更新します。</Text>
      {session.can("alerts.read") && (
        <Button label={summary?.openAlerts ? `アラート(未対応 ${summary.openAlerts} 件)を見る` : "アラートを見る"} kind={summary?.openAlerts ? "primary" : "secondary"} onPress={onOpenAlerts} />
      )}
      {billing?.state === "restricted" && <Message text={RESTRICTED_MESSAGE} tone="warn" />}
      {session.can("persons.write") && billing?.state !== "restricted" && <Button label="登録者を追加" kind="secondary" onPress={onCreatePerson} />}
      <Field label={tile ? `${tile.label}の登録者を検索` : "登録者を検索"} value={q} onChangeText={setQ} placeholder="氏名・社員番号" autoCapitalize="none" />
      <Message text={error} />
      <Text style={{ color: color.sub }}>
        {total} 件{tile ? `(${tile.label}・期限の近い順)` : ""}
      </Text>
      {items.map((p) => (
        <Pressable key={p.id} onPress={() => onOpenPerson(p.id)}>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "600", flexShrink: 1 }}>
                {p.name}({p.employeeCode})
              </Text>
              <Text style={{ color: color[bucketTone(p.expiry.bucket) ?? "sub"] }}>{EXPIRY_BUCKET_LABEL[p.expiry.bucket]}</Text>
            </View>
            <Text style={{ color: color.sub }}>
              {p.siteName}
              {p.expiry.deadline ? ` ・ 期限 ${p.expiry.deadline}(残り ${p.expiry.daysLeft} 日)` : ""}
              {p.expiry.icUnverified ? " ・ IC未検証" : ""}
              {p.expiry.needsReview ? " ・ 要確認" : ""}
              {p.status === "retired" ? " ・ 退職" : ""}
            </Text>
          </Card>
        </Pressable>
      ))}
      {items.length < total && <Button label={`さらに表示(残り ${total - items.length} 件)`} kind="secondary" busy={loadingMore} onPress={() => void more()} />}
      {__DEV__ && <Button label="IC 読み取り PoC(開発用)" kind="secondary" onPress={onOpenPoc} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tile: { width: "23.5%", borderWidth: 1, borderColor: color.border, borderRadius: 10, paddingVertical: 8, alignItems: "center", backgroundColor: "#fff" },
  tileOn: { borderColor: color.primary, backgroundColor: "#ddf4ff" },
  tileCount: { fontSize: 20, fontWeight: "700", color: color.text },
  tileLabel: { fontSize: 11, color: color.sub },
  chip: { borderWidth: 1, borderColor: color.border, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#fff" },
  chipOn: { borderColor: color.primary, backgroundColor: "#ddf4ff" },
  chipText: { color: color.text, fontSize: 13 },
});
