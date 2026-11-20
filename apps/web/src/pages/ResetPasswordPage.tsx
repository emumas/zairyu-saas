/** パスワード再設定のリンク(/reset-password#<トークン>)から新しいパスワードを設定する */
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { messageOf, publicApi } from "../api";
import { Button, Card, Field, Message } from "../ui";

export function ResetPasswordPage() {
  const [token] = useState(() => window.location.hash.slice(1));
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
      const r = await publicApi.auth.resetPassword.mutate({ token, password });
      setDone(r.email);
      // トークンをアドレスバーと履歴から消す
      window.history.replaceState(null, "", "/reset-password");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <Card title="新しいパスワードの設定">
        {done ? (
          <>
            <p>{done} のパスワードを変更しました。すべての端末でログアウトしたので、新しいパスワードでログインし直してください。</p>
            <Link to="/">ログイン画面へ</Link>
          </>
        ) : !token ? (
          <Message text="リンクが正しくありません。メールのリンクをそのまま開いてください。" />
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <Field label="新しいパスワード(12 文字以上)" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Field label="新しいパスワード(確認)" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
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
