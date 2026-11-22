/**
 * テナント設定(テナント管理者)
 * - 退職後の保存期間: 過ぎたデータは毎日の処理で自動的に削除される(1-21)
 * - 監査ログの保存期間: 過ぎた記録は毎日の処理で削除される
 */
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { Button, Card, Message } from "../ui";

type Settings = { retentionYears: number; auditRetentionYears: number };

export function SettingsPage() {
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<keyof Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.org.settings.get.query().then(
      (s) => {
        const v = { retentionYears: s.retentionYears, auditRetentionYears: s.auditRetentionYears };
        setForm(v);
        setSaved(v);
      },
      (e) => setError(messageOf(e)),
    );
  }, []);

  async function save(key: keyof Settings, warning: string) {
    if (!form || !saved) return;
    if (form[key] < saved[key] && !window.confirm(warning)) return;
    setBusy(key);
    try {
      const r = await api.org.settings.update.mutate({ [key]: form[key] });
      setSaved(r);
      setForm((f) => (f ? { ...f, [key]: r[key] } : f));
      setMsg("保存しました");
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>設定</h1>
      <Message text={error} />
      <Message text={msg} tone="ok" />
      {form && saved && (
        <>
          <Card title="退職後の保存期間">
            <p className="sub">
              退職(またはアーカイブ)した登録者のカード情報・画像・確認履歴は、退職日からこの期間を過ぎると自動的に削除されます(毎日深夜に処理)。
              削除したデータは元に戻せません。監査ログ(操作の記録。氏名などの値は含みません)は下の保存期間まで残ります。
            </p>
            <div className="row">
              <select value={form.retentionYears} onChange={(e) => setForm({ ...form, retentionYears: Number(e.target.value) })}>
                {[3, 4, 5].map((y) => (
                  <option key={y} value={y}>
                    {y} 年{y === 5 ? "(標準)" : ""}
                  </option>
                ))}
              </select>
              <Button
                onClick={() =>
                  void save(
                    "retentionYears",
                    `保存期間を ${form.retentionYears} 年に短くすると、退職から ${form.retentionYears} 年を過ぎた登録者のデータは次回の処理(毎日深夜)で削除され、元に戻せません。変更しますか?`,
                  )
                }
                busy={busy === "retentionYears"}
                disabled={form.retentionYears === saved.retentionYears}
              >
                保存
              </Button>
            </div>
          </Card>
          <Card title="監査ログの保存期間">
            <p className="sub">
              ログイン・登録者の変更・カード画像の閲覧・出力などの操作の記録(監査ログ)は、記録した日からこの期間を過ぎると自動的に削除されます(毎日深夜に処理)。
              削除したことは件数だけ新しい記録として残ります。退職後の保存期間(最長 5 年)より短くはできません。確認履歴(在留カードを確認した記録)は退職後の保存期間に従います。
            </p>
            <div className="row">
              <select value={form.auditRetentionYears} onChange={(e) => setForm({ ...form, auditRetentionYears: Number(e.target.value) })}>
                {[5, 6, 7, 8, 9, 10].map((y) => (
                  <option key={y} value={y}>
                    {y} 年{y === 7 ? "(標準)" : ""}
                  </option>
                ))}
              </select>
              <Button
                onClick={() =>
                  void save(
                    "auditRetentionYears",
                    `監査ログの保存期間を ${form.auditRetentionYears} 年に短くすると、${form.auditRetentionYears} 年より前の記録は次回の処理(毎日深夜)で削除され、元に戻せません。変更しますか?`,
                  )
                }
                busy={busy === "auditRetentionYears"}
                disabled={form.auditRetentionYears === saved.auditRetentionYears}
              >
                保存
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
