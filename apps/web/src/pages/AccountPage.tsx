/** アカウント: パスワードの変更と、認証アプリの付け替え(スマホの機種変更などで今の認証アプリが手元にある場合) */
import QRCode from "qrcode";
import { useState, type FormEvent } from "react";
import { api, messageOf, setAccessToken } from "../api";
import { useSession } from "../session";
import { Button, Card, Field, Message } from "../ui";

export function AccountPage() {
  const me = useSession().me;
  return (
    <>
      <h1>アカウント</h1>
      <p className="sub">{me?.email}</p>
      <PasswordChange />
      <TotpChange />
    </>
  );
}

function PasswordChange() {
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.next !== f.confirm) return setError("確認用のパスワードが一致しません");
    setBusy(true);
    setError(null);
    try {
      const pair = await api.auth.changePassword.mutate({ currentPassword: f.current, newPassword: f.next });
      // この端末は新しいトークンで続ける(リフレッシュトークンは Cookie に入る)
      setAccessToken(pair.accessToken);
      setF({ current: "", next: "", confirm: "" });
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="パスワードの変更">
      <form onSubmit={(e) => void submit(e)}>
        <Field label="今のパスワード" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
        <Field label="新しいパスワード(12 文字以上)" type="password" autoComplete="new-password" minLength={12} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
        <Field label="新しいパスワード(確認)" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />
        <Message text={error} />
        <Message text={done ? "変更しました。ほかの端末(アプリなど)ではログインし直してください。" : null} tone="ok" />
        <Button type="submit" busy={busy}>
          変更する
        </Button>
      </form>
    </Card>
  );
}

function TotpChange() {
  const [step, setStep] = useState<"start" | "scan" | "done">("start");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qr: string; changeToken: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="認証アプリの付け替え">
      <p className="sub">
        スマホの機種変更などで、新しいスマホの認証アプリに切り替えるときに使います。今の認証アプリの 6 桁が必要です。スマホをなくして今のコードが分からない場合は、テナント管理者に「認証アプリをリセット」を依頼してください。
      </p>
      {step === "start" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.auth.beginTotpChange.mutate({ password, code });
              setSetup({ secret: r.secret, changeToken: r.changeToken, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }) });
              setPassword("");
              setCode("");
              setStep("scan");
            });
          }}
        >
          <Field label="パスワード" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Field label="今の認証アプリの 6 桁" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          <Message text={error} />
          <Button type="submit" busy={busy}>
            次へ
          </Button>
        </form>
      )}
      {step === "scan" && setup && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.auth.confirmTotpChange.mutate({ changeToken: setup.changeToken, code });
              setSetup(null);
              setStep("done");
            });
          }}
        >
          <p>新しいスマホの認証アプリで、この QR コードを読み取ってください(5 分以内)。読み取れない場合はキーを手入力します。</p>
          <img src={setup.qr} alt="認証アプリ用の QR コード" width={220} height={220} />
          <p>
            キー: <code>{setup.secret}</code>
          </p>
          <Field label="新しい認証アプリに表示された 6 桁" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          <Message text={error} />
          <Button type="submit" busy={busy}>
            切り替える
          </Button>
        </form>
      )}
      {step === "done" && <Message text="切り替えました。次のログインから新しい認証アプリの 6 桁を使います。古いスマホの登録は削除して構いません。" tone="ok" />}
    </Card>
  );
}
