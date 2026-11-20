/** アラートの一覧(未対応)と対応済みにする操作 */
import { ALERT_LABEL, type AlertType } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api, messageOf } from "../api";
import { useSession } from "../auth/session";
import { Button, Card, color, Message, Screen } from "../ui/kit";

type Alert = Awaited<ReturnType<typeof api.alerts.list.query>>[number];

export function AlertsScreen({ onBack, onOpenPerson }: { onBack: () => void; onOpenPerson: (id: string) => void }) {
  const session = useSession();
  const [items, setItems] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.alerts.list.query({ open: true, limit: 100, offset: 0 }));
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function ack(id: string) {
    setBusyId(id);
    try {
      await api.alerts.acknowledge.mutate({ id });
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen title="アラート(未対応)" onBack={onBack}>
      <Message text={error} />
      {items?.length === 0 && <Text style={{ color: color.sub }}>未対応のアラートはありません</Text>}
      {items?.map((a) => (
        <Card key={a.id}>
          <Text style={{ fontWeight: "700", color: a.type === "needs_review" || a.type === "expired" ? color.danger : color.warn }}>
            {ALERT_LABEL[a.type as AlertType] ?? a.type}
          </Text>
          <Text onPress={() => onOpenPerson(a.person.id)} style={{ color: color.primary }}>
            {a.person.name}({a.person.employeeCode}・{a.person.siteName})
          </Text>
          <Text style={{ color: color.sub }}>通知日 {a.dueDate}</Text>
          {session.can("alerts.ack") && (
            <View style={{ marginTop: 4 }}>
              <Button label="対応済みにする" kind="secondary" busy={busyId === a.id} onPress={() => void ack(a.id)} />
            </View>
          )}
        </Card>
      ))}
    </Screen>
  );
}
