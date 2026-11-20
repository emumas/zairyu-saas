import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { messageOf } from "../api";
import { useSession, type LoginStep } from "../session";
import { Button, Card, Field, Message } from "../ui";

export function LoginPage() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<LoginStep | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
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

  useEffect(() => {
    if (step?.kind !== "totpSetup" || setup) return;
    void run(async () => {
      const s = await session.beginTotpSetup(step.setupToken);
      setSetup({ ...s, qr: await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 220 }) });
    });
  }, [step]);

  const submit = (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    void run(fn);
  };

  return (
    <main className="center">
      <Card title="在留カード管理 ログイン">
        {!step && (
          <form
            onSubmit={(e) =>
              submit(e, async () => {
                const r = await session.login(email, password);
                setPassword("");
                if (r.kind !== "done") setStep(r);
              })
            }
          >
            <Field label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Field label="パスワード" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Message text={error} />
            <Button type="submit" busy={busy}>
              ログイン
            </Button>
          </form>
        )}
        {step?.kind === "totp" && (
          <form onSubmit={(e) => submit(e, () => session.verifyTotp(step.challengeToken, code))}>
            <p>認証アプリに表示されている 6 桁のコードを入力してください。</p>
            <Field label="確認コード" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <Message text={error} />
            <Button type="submit" busy={busy} disabled={code.length !== 6}>
              ログイン
            </Button>
          </form>
        )}
        {step?.kind === "totpSetup" && (
          <form onSubmit={(e) => submit(e, () => session.confirmTotpSetup(step.setupToken, code))}>
            <p>管理者のアカウントは、パスワードに加えて認証アプリ(Google Authenticator など)の確認コードが必要です。</p>
            {setup ? (
              <>
                <p>1. スマホの認証アプリでこの QR コードを読み取ります。</p>
                <img src={setup.qr} alt="認証アプリ用の QR コード" width={220} height={220} />
                <p className="sub">読み取れない場合はキーを入力: <code>{setup.secret.replace(/(.{4})/g, "$1 ")}</code></p>
                <p>2. 認証アプリに表示された 6 桁のコードを入力します。</p>
                <Field label="確認コード" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
                <Button type="submit" busy={busy} disabled={code.length !== 6}>
                  設定してログイン
                </Button>
              </>
            ) : (
              <p>準備中…</p>
            )}
            <Message text={error} />
          </form>
        )}
      </Card>
    </main>
  );
}
