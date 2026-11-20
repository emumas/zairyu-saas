/** プラン(1-19)。変更はそのプランの全テナントの次の計算から効く(確定済みの月は変わらない) */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Card, Message } from "../ui";
import { papi, platformError, usePlatformSignOut } from "./PlatformApp";
import { fromRows, intOrNull, pricingText, TiersEditor, toRows, type TierRow } from "./pricing";

type Plan = Awaited<ReturnType<typeof papi.plans.list.query>>[number];
interface Form {
  id: string | null;
  name: string;
  baseFee: string;
  billingMode: "per_unit" | "tiered";
  unitPrice: string;
  tiers: TierRow[];
}
const empty: Form = { id: null, name: "", baseFee: "0", billingMode: "per_unit", unitPrice: "", tiers: toRows(null) };

export function PlansPage() {
  const signOut = usePlatformSignOut();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => papi.plans.list.query().then(setPlans, (e) => setError(platformError(e, signOut))), [signOut]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const plan = {
      name: form.name,
      baseFee: Number(form.baseFee),
      billingMode: form.billingMode,
      unitPrice: form.billingMode === "per_unit" ? intOrNull(form.unitPrice) : null,
      tiers: form.billingMode === "tiered" ? fromRows(form.tiers) : null,
    };
    if (form.id && !window.confirm("このプランのすべてのテナントの、次の計算から新しい料金になります。変更しますか?")) return;
    setBusy(true);
    try {
      if (form.id) await papi.plans.update.mutate({ id: form.id, plan });
      else await papi.plans.create.mutate(plan);
      setForm(null);
      setError(null);
      await load();
    } catch (err) {
      setError(platformError(err, signOut));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>プラン</h1>
      <Message text={error} />
      {form ? (
        <Card title={form.id ? "プランを変更" : "プランを追加"}>
          <form onSubmit={(e) => void save(e)}>
            <label className="field">
              <span>プラン名</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
            </label>
            <label className="field">
              <span>月額基本料(円・税抜)</span>
              <input type="number" min={0} value={form.baseFee} onChange={(e) => setForm({ ...form, baseFee: e.target.value })} required />
            </label>
            <label className="field">
              <span>料金方式</span>
              <select value={form.billingMode} onChange={(e) => setForm({ ...form, billingMode: e.target.value as Form["billingMode"] })}>
                <option value="per_unit">基本料+単価</option>
                <option value="tiered">段階制(人数帯ごとに積み上げ)</option>
              </select>
            </label>
            {form.billingMode === "per_unit" ? (
              <label className="field">
                <span>登録者 1 人あたりの単価(円・税抜)</span>
                <input type="number" min={0} value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} required />
              </label>
            ) : (
              <div className="field">
                <span>人数帯と単価(円・税抜)。例: 1〜100 人は 300 円、101 人〜は 250 円で積み上げ</span>
                <TiersEditor rows={form.tiers} onChange={(tiers) => setForm({ ...form, tiers })} />
              </div>
            )}
            <div className="row">
              <Button kind="secondary" type="button" onClick={() => setForm(null)}>
                やめる
              </Button>
              <Button type="submit" busy={busy}>
                保存
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <p>
          <Button onClick={() => setForm(empty)}>プランを追加</Button>
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>プラン名</th>
            <th>料金(税抜)</th>
            <th className="num">テナント数</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{pricingText(p)}</td>
              <td className="num">{p.tenantCount}</td>
              <td>
                <Button
                  kind="secondary"
                  onClick={() => setForm({ id: p.id, name: p.name, baseFee: String(p.baseFee), billingMode: p.billingMode, unitPrice: p.unitPrice === null ? "" : String(p.unitPrice), tiers: toRows(p.tiers) })}
                >
                  変更
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
