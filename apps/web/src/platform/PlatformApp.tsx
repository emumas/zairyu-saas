/**
 * 運営者コンソール(1-19)。テナントの管理画面とは別のログイン(運営者アカウント・TOTP 必須)。
 * セッションは HttpOnly Cookie(JavaScript からは読めない)。登録者の個人情報は表示しない
 */
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { messageOf, publicApi } from "../api";
import { Button, Card, Field, Message } from "../ui";
import { PlansPage } from "./PlansPage";
import { TenantDetailPage } from "./TenantDetailPage";
import { TenantsPage } from "./TenantsPage";

export const papi = publicApi.platform;

const SignOutContext = createContext<() => void>(() => {});
/** セッション切れ(401)で呼ぶとログイン画面に戻る */
export const usePlatformSignOut = () => useContext(SignOutContext);

/** 401 ならログイン画面に戻す */
export function platformError(e: unknown, signOut: () => void): string {
  if ((e as { data?: { code?: string } } | null)?.data?.code === "UNAUTHORIZED") {
    signOut();
    return "ログインし直してください";
  }
  return messageOf(e);
}

function PlatformLogin({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <Card title="運営者コンソール ログイン">
        {!challenge ? (
          <form
            onSubmit={(e) =>
              void submit(e, async () => {
                const r = await papi.auth.login.mutate({ email, password });
                setPassword("");
                setChallenge(r.challengeToken);
              })
            }
          >
            <Field label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Field label="パスワード" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Message text={error} />
            <Button type="submit" busy={busy}>
              次へ
            </Button>
          </form>
        ) : (
          <form
            onSubmit={(e) =>
              void submit(e, async () => {
                const r = await papi.auth.verifyTotp.mutate({ challengeToken: challenge, code });
                onDone(r.email);
              })
            }
          >
            <Field label="認証アプリの 6 桁" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            <Message text={error} />
            <Button type="submit" busy={busy}>
              ログイン
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}

export function PlatformApp() {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    papi.auth.me.query().then(
      (r) => setMe(r.email),
      () => setMe(null),
    );
  }, []);
  const signOut = useCallback(() => setMe(null), []);

  if (me === undefined) return <main className="center">読み込み中…</main>;
  if (me === null) return <PlatformLogin onDone={setMe} />;
  return (
    <SignOutContext.Provider value={signOut}>
      <div className="layout">
        <nav>
          <strong className="brand">運営者コンソール</strong>
          <NavLink to="/platform/tenants">テナント</NavLink>
          <NavLink to="/platform/plans">プラン</NavLink>
          <div className="nav-foot">
            <div>{me}</div>
            <div className="sub">運営者</div>
            <button className="link" onClick={() => void papi.auth.logout.mutate().finally(() => setMe(null))}>
              ログアウト
            </button>
          </div>
        </nav>
        <main>
          <Routes>
            <Route path="tenants" element={<TenantsPage />} />
            <Route path="tenants/:id" element={<TenantDetailPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="*" element={<Navigate to="/platform/tenants" replace />} />
          </Routes>
        </main>
      </div>
    </SignOutContext.Provider>
  );
}
