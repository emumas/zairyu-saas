/** 料金の表示と人数帯の入力(運営者コンソール) */
import type { PricingTier } from "@zairyu/shared";

export const yen = (n: number) => `${n.toLocaleString("ja-JP")} 円`;

export function tiersText(tiers: readonly PricingTier[]): string {
  let from = 1;
  return tiers
    .map((t) => {
      const s = t.upTo === null ? `${from} 人〜 ${yen(t.unitPrice)}` : `${from}〜${t.upTo} 人 ${yen(t.unitPrice)}`;
      if (t.upTo !== null) from = t.upTo + 1;
      return s;
    })
    .join("、");
}

export function pricingText(p: { baseFee: number; billingMode: "per_unit" | "tiered"; unitPrice: number | null; tiers: PricingTier[] | null }): string {
  const base = `基本料 ${yen(p.baseFee)}`;
  return p.billingMode === "per_unit" ? `${base} + 1 人 ${yen(p.unitPrice ?? 0)}` : `${base} + 段階制(${tiersText(p.tiers ?? [])})`;
}

/** 数値の入力欄の値(空なら null) */
export const intOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

export interface TierRow {
  upTo: string;
  unitPrice: string;
}
export const toRows = (tiers: readonly PricingTier[] | null): TierRow[] =>
  tiers?.map((t) => ({ upTo: t.upTo === null ? "" : String(t.upTo), unitPrice: String(t.unitPrice) })) ?? [
    { upTo: "100", unitPrice: "" },
    { upTo: "", unitPrice: "" },
  ];
export const fromRows = (rows: TierRow[]): PricingTier[] => rows.map((r) => ({ upTo: intOrNull(r.upTo), unitPrice: Number(r.unitPrice) }));

/** 人数帯の入力。最後の行は上限なし */
export function TiersEditor({ rows, onChange }: { rows: TierRow[]; onChange: (rows: TierRow[]) => void }) {
  const set = (i: number, patch: Partial<TierRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="tiers">
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        return (
          <div className="row" key={i}>
            <span className="sub">{i === 0 ? "1" : rows[i - 1]!.upTo ? Number(rows[i - 1]!.upTo) + 1 : "?"} 人〜</span>
            {last ? (
              <span className="sub">上限なし</span>
            ) : (
              <input type="number" min={1} placeholder="上限(人)" value={r.upTo} onChange={(e) => set(i, { upTo: e.target.value })} required />
            )}
            <input type="number" min={0} placeholder="単価(円)" value={r.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} required />
            {rows.length > 1 && (
              <button type="button" className="link" onClick={() => onChange(rows.filter((_, j) => j !== i).map((x, j, a) => (j === a.length - 1 ? { ...x, upTo: "" } : x)))}>
                削除
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="link" onClick={() => onChange([...rows.slice(0, -1), { upTo: "", unitPrice: "" }, rows[rows.length - 1]!])}>
        人数帯を追加
      </button>
    </div>
  );
}
