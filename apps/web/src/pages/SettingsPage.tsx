/**
 * テナント設定(テナント管理者)
 * - 退職後の保存期間: 過ぎたデータは毎日の処理で自動的に削除される(1-21)
 * - 監査ログの保存期間: 過ぎた記録は毎日の処理で削除される
 */
import { useEffect, useState } from "react";
import { api, messageOf } from "../api";
import { Button, Card, Message } from "../ui";

type Settings = { retentionYears: number; auditRetentionYears: number };
type Employer = { name: string; address: string; phone: string; representativeName: string; noticesFrom: string };

/** 外国人雇用状況の届出に書く事業主の情報 */
function EmployerCard() {
  const [f, setF] = useState<Employer | null>(null);
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.org.settings.employer.query().then(
      (e) => {
        setF({ name: e.name ?? "", address: e.address ?? "", phone: e.phone ?? "", representativeName: e.representativeName ?? "", noticesFrom: e.noticesFrom });
        setFrom(e.noticesFrom);
      },
      (e) => setError(messageOf(e)),
    );
  }, []);
  if (!f) return <Message text={error} />;
  const set = (k: keyof Employer) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    if (!f) return;
    setBusy(true);
    try {
      if (f.noticesFrom < from && !window.confirm(`${f.noticesFrom} 以後の入社・退職がすべて「届出」の一覧に出ます(提出済みのものは「提出済みにする」で記録してください)。変更しますか?`)) return;
      await api.org.settings.updateEmployer.mutate(f);
      setFrom(f.noticesFrom);
      setMsg("保存しました");
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="届出用の事業主の情報">
      <p className="sub">外国人雇用状況の届出に書く、事業主(法人)の情報です。{from} 以後の雇入れ・離職を「届出」画面で管理しています。</p>
      <label className="field">
        <span>法人の名称(空欄ならテナント名)</span>
        <input value={f.name} onChange={set("name")} maxLength={100} />
      </label>
      <label className="field">
        <span>主たる事務所の所在地</span>
        <input value={f.address} onChange={set("address")} maxLength={200} />
      </label>
      <label className="field">
        <span>主たる事務所の電話番号</span>
        <input value={f.phone} onChange={set("phone")} maxLength={20} />
      </label>
      <label className="field">
        <span>代表者の氏名</span>
        <input value={f.representativeName} onChange={set("representativeName")} maxLength={50} />
      </label>
      <label className="field">
        <span>届出の管理を始める日(この日以後の雇入れ・離職を「届出」の一覧に出します)</span>
        <input type="date" value={f.noticesFrom} onChange={set("noticesFrom")} />
      </label>
      <Message text={error} />
      <Message text={msg} tone="ok" />
      <Button busy={busy} onClick={() => void save()}>
        保存
      </Button>
    </Card>
  );
}

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
          <EmployerCard />
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
