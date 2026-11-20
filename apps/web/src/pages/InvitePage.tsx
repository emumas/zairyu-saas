/** 招待リンク(/invite#<トークン>)からパスワードを設定する。トークンは URL のフラグメントなのでサーバーのログに残らない */
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { messageOf, publicApi } from "../api";
import { Button, Card, Field, Message } from "../ui";

export function InvitePage() {
  const token = window.location.hash.slice(1);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("確認用のパスワードが一致しません");
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi.auth.acceptInvitation.mutate({ token, password });
      setDone(r.email);
      // トークンをアドレスバーと履歴から消す
      window.history.replaceState(null, "", "/invite");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <Card title="在留カード管理 パスワードの設定">
        {done ? (
          <>
            <p>{done} のパスワードを設定しました。ログインしてください(管理者は続けて認証アプリの設定を行います)。</p>
            <Link to="/">ログイン画面へ</Link>
          </>
        ) : !token ? (
          <Message text="招待リンクが正しくありません。メールのリンクをそのまま開いてください。" />
        ) : (
          <form onSubmit={submit}>
            <Field label="パスワード(12 文字以上)" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Field label="パスワード(確認)" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            <Message text={error} />
            <Button type="submit" busy={busy}>
              設定する
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
