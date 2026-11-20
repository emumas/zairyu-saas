import { useState } from "react";
import { Linking, Text } from "react-native";
import { messageOf, publicApi } from "../api";
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
  /** パスワードを忘れた場合(再設定のリンクをメールで送る。設定は Web で行う) */
  const [forgot, setForgot] = useState<"form" | "sent" | null>(null);

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

  if (forgot) {
    return (
      <Screen title="パスワードの再設定" onBack={() => setForgot(null)}>
        {forgot === "sent" ? (
          <Text>
            {email} が登録されていれば、パスワード再設定のリンクをメールで送りました(1 時間有効)。メールのリンクから新しいパスワードを設定し、このアプリでログインし直してください。
          </Text>
        ) : (
          <>
            <Text>登録したメールアドレスに、再設定のリンクを送ります。認証アプリ(6 桁)は再設定後も必要です。</Text>
            <Field label="メールアドレス" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
            <Message text={error} />
            <Button
              label="再設定のリンクを送る"
              busy={busy}
              disabled={!email.trim()}
              onPress={() =>
                run(async () => {
                  await publicApi.auth.requestPasswordReset.mutate({ email: email.trim() });
                  setForgot("sent");
                })
              }
            />
          </>
        )}
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
      <Button label="パスワードを忘れた場合" kind="secondary" onPress={() => { setError(null); setForgot("form"); }} />
      <Text style={{ color: "#59636e" }}>
        アカウントは管理者から招待されます。スマホを替えた・なくした場合は、管理者に「認証アプリをリセット」を依頼してください。
      </Text>
    </Screen>
  );
}
