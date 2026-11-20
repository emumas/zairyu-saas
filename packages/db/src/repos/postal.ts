/**
 * 郵便番号データ(参照データ)。投入は管理ユーザー(テーブル所有者)で、参照はどのロールのトランザクションからでもよい
 */
import { matchTown, splitPrefecture, type PostalMatch, type PostalRow } from "@zairyu/shared";
import { and, count, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../client.js";
import { postalCodes } from "../schema.js";

/** 全件を入れ替える(1 つのトランザクション。途中で失敗したら元のまま) */
export async function replacePostalCodes(db: Db, rows: readonly PostalRow[]): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(postalCodes);
    for (let i = 0; i < rows.length; i += 2000) {
      await tx.insert(postalCodes).values(rows.slice(i, i + 2000).map((r) => ({ code: r.code, pref: r.pref, city: r.city, town: r.town, townKey: r.townKey })));
    }
    return rows.length;
  });
}

export async function postalCodeCount(tx: Tx | Db): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(postalCodes);
  return r?.n ?? 0;
}

/** 住所から郵便番号を引く。データが未投入なら loaded=false */
export async function lookupPostalCode(tx: Tx, address: string): Promise<PostalMatch & { loaded: boolean }> {
  const empty = { postalCode: null, level: null, candidates: [] };
  const { pref, rest } = splitPrefecture(address);
  if (!rest) return { ...empty, loaded: true };
  // 住所の先頭に一致する市区町村(いちばん長いもの。都道府県が無い住所は全国から)
  const cities = await tx
    .selectDistinct({ pref: postalCodes.pref, city: postalCodes.city })
    .from(postalCodes)
    .where(and(pref ? eq(postalCodes.pref, pref) : undefined, sql`${rest} like replace(${postalCodes.city}, 'ヶ', 'ケ') || '%'`));
  if (cities.length === 0) {
    const loaded = (await tx.select({ n: count() }).from(postalCodes).limit(1))[0]!.n > 0;
    return { ...empty, loaded };
  }
  const maxLen = Math.max(...cities.map((c) => c.city.length));
  const best = cities.filter((c) => c.city.length === maxLen);
  if (best.length > 1) {
    // 都道府県が書かれておらず、同じ名前の市区町村が複数ある(例: 府中市)
    const rows = await Promise.all(best.map((c) => tx.select().from(postalCodes).where(and(eq(postalCodes.pref, c.pref), eq(postalCodes.city, c.city), eq(postalCodes.townKey, "")))));
    return { postalCode: null, level: null, candidates: rows.flat().map((r) => ({ code: r.code, label: `${r.pref}${r.city}` })), loaded: true };
  }
  const { pref: p, city } = best[0]!;
  const rows = await tx.select().from(postalCodes).where(and(eq(postalCodes.pref, p), eq(postalCodes.city, city)));
  return { ...matchTown(rows, rest.slice(city.length)), loaded: true };
}
