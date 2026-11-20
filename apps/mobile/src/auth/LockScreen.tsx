import { useEffect, useState } from "react";
import { Text } from "react-native";
import { Button, Message, Screen } from "../ui/kit";
import { useSession } from "./session";

export function LockScreen() {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const unlock = async () => {
    setBusy(true);
    const r = await session.unlock().catch(() => ({ ok: false, message: "ロックを解除できませんでした" }));
    if (!r.ok) setMessage(r.message ?? null);
    setBusy(false);
  };

  useEffect(() => {
    void unlock();
    // 表示時に一度だけ自動で認証を出す
  }, []);

  return (
    <Screen title="ロック中">
      <Text>個人情報を保護するため、ロックを解除してください。</Text>
      <Message text={message} tone="warn" />
      <Button label="ロックを解除" busy={busy} onPress={unlock} />
      <Button label="ログアウト" kind="secondary" onPress={() => void session.logout()} />
    </Screen>
  );
}
