/** パスワードを忘れた場合: メールアドレスに再設定のリンクを送る(登録の有無は表示しない) */
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { messageOf, publicApi } from "../api";
import { Button, Card, Field, Message } from "../ui";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.auth.requestPasswordReset.mutate({ email });
      setSent(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <Card title="パスワードの再設定">
        {sent ? (
          <>
            <p>
              {email} が登録されていれば、パスワード再設定のリンクをメールで送りました(1 時間有効)。メールのリンクから新しいパスワードを設定してください。
            </p>
            <p className="sub">メールが届かない場合は、迷惑メールのフォルダを確かめるか、管理者に「パスワード再設定」のリンクの発行を依頼してください。</p>
            <Link to="/">ログイン画面へ</Link>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <p className="sub">登録したメールアドレスを入力してください。再設定のリンクを送ります。認証アプリ(6 桁のコード)は再設定後も必要です。</p>
            <Field label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <Message text={error} />
            <Button type="submit" busy={busy}>
              再設定のリンクを送る
            </Button>
            <Link to="/">ログイン画面に戻る</Link>
          </form>
        )}
      </Card>
    </main>
  );
}
