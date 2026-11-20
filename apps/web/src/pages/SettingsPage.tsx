/** テナント設定(テナント管理者): 退職後の保存期間。過ぎたデータは毎日の処理で自動的に削除される(1-21) */
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { Button, Card, Message } from "../ui";

export function SettingsPage() {
  const [years, setYears] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.org.settings.get.query().then(
      (s) => {
        setYears(s.retentionYears);
        setSaved(s.retentionYears);
      },
      (e) => setError(messageOf(e)),
    );
  }, []);

  async function save() {
    if (years === null) return;
    if (saved !== null && years < saved && !window.confirm(`保存期間を ${years} 年に短くすると、退職から ${years} 年を過ぎた登録者のデータは次回の処理(毎日深夜)で削除され、元に戻せません。変更しますか?`)) return;
    setBusy(true);
    try {
      const r = await api.org.settings.update.mutate({ retentionYears: years });
      setSaved(r.retentionYears);
      setMsg("保存しました");
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>設定</h1>
      <Message text={error} />
      <Message text={msg} tone="ok" />
      <Card title="退職後の保存期間">
        <p className="sub">
          退職(またはアーカイブ)した登録者のカード情報・画像・確認履歴は、退職日からこの期間を過ぎると自動的に削除されます(毎日深夜に処理)。
          削除したデータは元に戻せません。監査ログ(操作の記録。氏名などの値は含みません)は残ります。
        </p>
        {years !== null && (
          <div className="row">
            <select value={years} onChange={(e) => setYears(Number(e.target.value))}>
              {[3, 4, 5].map((y) => (
                <option key={y} value={y}>
                  {y} 年{y === 5 ? "(標準)" : ""}
                </option>
              ))}
            </select>
            <Button onClick={() => void save()} busy={busy} disabled={years === saved}>
              保存
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
