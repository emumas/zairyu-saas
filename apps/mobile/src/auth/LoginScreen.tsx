import { useState } from "react";
import { Linking, Text } from "react-native";
import { messageOf } from "../api";
import { Button, Card, Field, Message, Screen } from "../ui/kit";
import { useSession, type LoginStep } from "./session";

export function LoginScreen() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<LoginStep | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (step?.kind === "totp") {
    return (
      <Screen title="確認コード">
        <Text>認証アプリに表示されている 6 桁のコードを入力してください。</Text>
        <Field label="確認コード" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoFocus />
        <Message text={error} />
        <Button label="ログイン" busy={busy} disabled={code.length !== 6} onPress={() => run(() => session.verifyTotp(step.challengeToken, code))} />
        <Button label="やり直す" kind="secondary" onPress={() => { setStep(null); setCode(""); }} />
      </Screen>
    );
  }

  if (step?.kind === "totpSetup") {
    return (
      <Screen title="認証アプリの設定">
        <Text>管理者のアカウントは、パスワードに加えて認証アプリ(Google Authenticator など)の確認コードが必要です。</Text>
        {!setup ? (
          <Button label="設定を始める" busy={busy} onPress={() => run(async () => setSetup(await session.beginTotpSetup(step.setupToken)))} />
        ) : (
          <Card>
            <Text>1. 下のボタンで認証アプリに追加します(同じ端末にアプリがある場合)。別の端末の場合は、キーを手で入力してください。</Text>
            <Button label="認証アプリに追加" kind="secondary" onPress={() => Linking.openURL(setup.otpauthUri).catch(() => setError("認証アプリを開けませんでした。キーを手で入力してください"))} />
            <Text selectable style={{ fontFamily: "monospace", fontSize: 16 }}>
              {setup.secret.replace(/(.{4})/g, "$1 ")}
            </Text>
            <Text>2. 認証アプリに表示された 6 桁のコードを入力します。</Text>
            <Field label="確認コード" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
            <Button label="設定してログイン" busy={busy} disabled={code.length !== 6} onPress={() => run(() => session.confirmTotpSetup(step.setupToken, code))} />
          </Card>
        )}
        <Message text={error} />
      </Screen>
    );
  }

  return (
    <Screen title="在留カード管理">
      <Field label="メールアドレス" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="パスワード" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      <Message text={error} />
      <Button
        label="ログイン"
        busy={busy}
        disabled={!email || !password}
        onPress={() =>
          run(async () => {
            const r = await session.login(email, password);
            setPassword("");
            if (r.kind !== "done") setStep(r);
          })
        }
      />
      <Text style={{ color: "#59636e" }}>アカウントは管理者から招待されます。契約は Web の管理画面から行います。</Text>
    </Screen>
  );
}
