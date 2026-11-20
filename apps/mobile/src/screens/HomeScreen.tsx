/** ホーム: 期限区分の件数(ダッシュボード)と登録者の検索 */
import { EXPIRY_BUCKET_LABEL, RESTRICTED_MESSAGE, type ExpiryBucket } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Card, color, Field, Message, Screen } from "../ui/kit";
import { bucketTone } from "./format";

type Summary = Awaited<ReturnType<typeof api.dashboard.summary.query>>;
type PersonItem = Awaited<ReturnType<typeof api.persons.list.query>>["items"][number];

const TILES: { bucket?: ExpiryBucket; flag?: "icUnverified" | "needsReview"; label: string }[] = [
  { bucket: "expired", label: "期限切れ" },
  { bucket: "within30", label: "30日以内" },
  { bucket: "within90", label: "90日以内" },
  { bucket: "pending", label: "更新申請中" },
  { flag: "icUnverified", label: "IC未検証" },
  { flag: "needsReview", label: "要確認" },
];

type Filter = { bucket?: ExpiryBucket; flag?: "icUnverified" | "needsReview"; label: string } | null;

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
  // 未払い時の制御(1-18)。アプリには料金・支払いの案内を出さない(App Store 3.1.3。契約は Web だけ)
  const billing = session.state.status === "signedIn" ? session.state.me.billing : null;
  const me = session.state.status === "signedIn" ? session.state.me : null;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [items, setItems] = useState<PersonItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, list] = await Promise.all([
        api.dashboard.summary.query({}),
        api.persons.list.query({
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(filter?.bucket ? { expiryBuckets: [filter.bucket] } : {}),
          ...(filter?.flag === "icUnverified" ? { icUnverified: true } : {}),
          ...(filter?.flag === "needsReview" ? { needsReview: true } : {}),
          sort: filter ? "expiryDate" : "employeeCode",
          limit: 50,
        }),
      ]);
      setSummary(s);
      setItems(list.items);
      setTotal(list.total);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [q, filter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  const count = (t: (typeof TILES)[number]) => (summary ? (t.bucket ? summary.buckets[t.bucket] : summary[t.flag!]) : null);

  return (
    <Screen title="在留カード管理" right={<Text style={{ color: color.sub }} onPress={() => void session.logout()}>ログアウト</Text>}>
      <Text style={{ color: color.sub }}>
        {me?.email}(在籍 {summary?.total ?? "-"} 人、基準日 {summary?.today ?? "-"})
      </Text>
      <View style={styles.tiles}>
        {TILES.map((t) => {
          const n = count(t);
          const active = filter?.label === t.label;
          return (
            <Pressable key={t.label} style={[styles.tile, active && styles.tileOn]} onPress={() => setFilter(active ? null : t)}>
              <Text style={[styles.tileCount, n ? { color: t.bucket ? color[bucketTone(t.bucket) ?? "text"] : color.warn } : null]}>{n ?? "-"}</Text>
              <Text style={styles.tileLabel}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {session.can("alerts.read") && <Button label="アラート(未対応)を見る" kind="secondary" onPress={onOpenAlerts} />}
      {billing?.state === "restricted" && <Message text={RESTRICTED_MESSAGE} tone="warn" />}
      {session.can("persons.write") && billing?.state !== "restricted" && <Button label="登録者を追加" kind="secondary" onPress={onCreatePerson} />}
      <Field label={filter ? `${filter.label}の登録者を検索` : "登録者を検索"} value={q} onChangeText={setQ} placeholder="氏名・社員番号" autoCapitalize="none" />
      <Message text={error} />
      <Text style={{ color: color.sub }}>{total} 件</Text>
      {items.map((p) => (
        <Pressable key={p.id} onPress={() => onOpenPerson(p.id)}>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "600" }}>
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
      {__DEV__ && <Button label="IC 読み取り PoC(開発用)" kind="secondary" onPress={onOpenPoc} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "31%", borderWidth: 1, borderColor: color.border, borderRadius: 10, padding: 10, alignItems: "center" },
  tileOn: { borderColor: color.primary, backgroundColor: "#ddf4ff" },
  tileCount: { fontSize: 22, fontWeight: "700", color: color.text },
  tileLabel: { fontSize: 12, color: color.sub },
});
