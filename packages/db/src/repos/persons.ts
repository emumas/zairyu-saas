/**
 * 登録者のリポジトリ。拠点の範囲(scope)は呼び出し側(権限ミドルウェア)が決め、ここで必ず SQL に反映する。
 * テナントの絞り込みは RLS が行う(withTenant のトランザクションで呼ぶこと)。
 */
import { toKatakana, type ExpiryBucket } from "@zairyu/shared";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { personEmployments, persons, residenceCards, sites } from "../schema.js";
import { expiryBucketSql, icUnverifiedSql, needsReviewSql } from "./expiry.js";

/** null は全拠点、配列はその拠点だけ(空なら何も見えない) */
export type SiteScope = readonly string[] | null;

type PersonStatus = "active" | "retired" | "archived";

export interface PersonListQuery {
  scope: SiteScope;
  q?: string | undefined;
  siteId?: string | undefined;
  statuses?: readonly PersonStatus[] | undefined;
  sort: "employeeCode" | "name" | "expiryDate";
  limit: number;
  offset: number;
  /** 期限区分の判定日(JST) */
  today: string;
  expiryBuckets?: readonly ExpiryBucket[] | undefined;
  icUnverified?: boolean | undefined;
  needsReview?: boolean | undefined;
}

const summaryColumns = (today: string) => ({
  expiryBucket: expiryBucketSql(today),
  id: persons.id,
  siteId: persons.siteId,
  siteName: sites.name,
  employeeCode: persons.employeeCode,
  name: persons.name,
  nameKana: persons.nameKana,
  phone: persons.phone,
  nationality: persons.nationality,
  birthDate: persons.birthDate,
  hiredAt: persons.hiredAt,
  status: persons.status,
  retiredAt: persons.retiredAt,
  archivedAt: persons.archivedAt,
  updatedAt: persons.updatedAt,
  card: {
    id: residenceCards.id,
    cardFormat: residenceCards.cardFormat,
    statusOfResidence: residenceCards.statusOfResidence,
    expiryDate: residenceCards.expiryDate,
    cardValidUntil: residenceCards.cardValidUntil,
    workRestriction: residenceCards.workRestriction,
    outsideActivity: residenceCards.outsideActivity,
    pendingApplication: residenceCards.pendingApplication,
    icVerified: residenceCards.icVerified,
    needsReview: residenceCards.needsReview,
  },
});

const currentCardJoin = and(eq(residenceCards.personId, persons.id), eq(residenceCards.isCurrent, true));

function scopeCondition(scope: SiteScope): SQL | undefined {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  return inArray(persons.siteId, [...scope]);
}

/**
 * 状態の指定がないときの既定: 期限区分・目印で絞り込むときは在籍中のみ(退職者の期限は管理対象外)、
 * それ以外は在籍中と退職(アーカイブを除く)
 */
function defaultStatuses(q: PersonListQuery): PersonStatus[] {
  return q.expiryBuckets?.length || q.icUnverified || q.needsReview ? ["active"] : ["active", "retired"];
}

/** LIKE のワイルドカードを無効にする */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPersons(tx: Tx, q: PersonListQuery) {
  const conds: (SQL | undefined)[] = [
    scopeCondition(q.scope),
    inArray(persons.status, [...(q.statuses ?? defaultStatuses(q))]),
  ];
  if (q.siteId) conds.push(eq(persons.siteId, q.siteId));
  if (q.expiryBuckets?.length) conds.push(inArray(expiryBucketSql(q.today), [...q.expiryBuckets]));
  if (q.icUnverified) conds.push(icUnverifiedSql);
  if (q.needsReview) conds.push(needsReviewSql);
  if (q.q) {
    const e = escapeLike(q.q);
    const kana = escapeLike(toKatakana(q.q));
    conds.push(or(ilike(persons.name, `%${e}%`), kana ? ilike(persons.nameKana, `%${kana}%`) : undefined, ilike(persons.employeeCode, `${e}%`)));
  }
  const where = and(...conds);
  const order =
    q.sort === "name"
      ? [asc(persons.name), asc(persons.id)]
      : q.sort === "expiryDate"
        ? [sql`${residenceCards.expiryDate} asc nulls last`, asc(persons.id)]
        : [asc(persons.employeeCode), asc(persons.id)];

  const items = await tx
    .select(summaryColumns(q.today))
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .leftJoin(residenceCards, currentCardJoin)
    .where(where)
    .orderBy(...order)
    .limit(q.limit)
    .offset(q.offset);
  const [total] = await tx.select({ n: count() }).from(persons).leftJoin(residenceCards, currentCardJoin).where(where);
  return { items, total: total?.n ?? 0 };
}

export async function getPerson(tx: Tx, id: string, scope: SiteScope, today: string) {
  const [row] = await tx
    .select(summaryColumns(today))
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .leftJoin(residenceCards, currentCardJoin)
    .where(and(eq(persons.id, id), scopeCondition(scope)));
  return row ?? null;
}

export async function createPerson(
  tx: Tx,
  input: {
    siteId: string;
    employeeCode: string;
    name: string;
    nameKana?: string | null | undefined;
    phone?: string | null | undefined;
    nationality?: string | null | undefined;
    birthDate?: string | null | undefined;
    hiredAt?: string | null | undefined;
  },
) {
  const [row] = await tx
    .insert(persons)
    .values({
      siteId: input.siteId,
      employeeCode: input.employeeCode,
      name: input.name,
      nameKana: input.nameKana ?? null,
      phone: input.phone ?? null,
      nationality: input.nationality ?? null,
      birthDate: input.birthDate ?? null,
      hiredAt: input.hiredAt ?? null,
    })
    .returning({ id: persons.id });
  return row!.id;
}

export async function findPersonSite(tx: Tx, id: string): Promise<{ siteId: string; status: PersonStatus } | null> {
  const [row] = await tx.select({ siteId: persons.siteId, status: persons.status }).from(persons).where(eq(persons.id, id));
  return row ?? null;
}

export async function updatePerson(
  tx: Tx,
  id: string,
  patch: Partial<{
    siteId: string;
    employeeCode: string;
    name: string;
    nameKana: string | null;
    phone: string | null;
    nationality: string | null;
    birthDate: string | null;
    hiredAt: string | null;
  }>,
): Promise<void> {
  await tx
    .update(persons)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(persons.id, id));
}

export async function setPersonStatus(
  tx: Tx,
  id: string,
  status: PersonStatus,
  dates: { retiredAt?: string | null; archivedAt?: Date | null },
): Promise<void> {
  await tx
    .update(persons)
    .set({ status, ...dates, updatedAt: new Date() })
    .where(eq(persons.id, id));
}

/** 拠点がこのテナントに存在し、アーカイブされていないか(RLS により他テナントの拠点は見えない) */
export async function isActiveSite(tx: Tx, siteId: string): Promise<boolean> {
  const [row] = await tx.select({ archivedAt: sites.archivedAt }).from(sites).where(eq(sites.id, siteId));
  return !!row && row.archivedAt === null;
}

/**
 * ダッシュボードの件数(在籍中の登録者のみ)。期限区分ごとの件数と、IC 未検証・要確認の件数
 */
export async function countByExpiry(tx: Tx, scope: SiteScope, today: string, siteId?: string) {
  const where = and(eq(persons.status, "active"), scopeCondition(scope), siteId ? eq(persons.siteId, siteId) : undefined);
  const bucket = expiryBucketSql(today);
  const rows = await tx
    .select({ bucket, n: count() })
    .from(persons)
    .leftJoin(residenceCards, currentCardJoin)
    .where(where)
    // 判定日をパラメータで渡すため、式ではなく列番号で集計する
    .groupBy(sql`1`);
  const [flags] = await tx
    .select({
      icUnverified: sql<number>`count(*) filter (where ${icUnverifiedSql})`.mapWith(Number),
      needsReview: sql<number>`count(*) filter (where ${needsReviewSql})`.mapWith(Number),
      total: count(),
    })
    .from(persons)
    .leftJoin(residenceCards, currentCardJoin)
    .where(where);
  return {
    buckets: Object.fromEntries(rows.map((r) => [r.bucket, r.n])) as Partial<Record<ExpiryBucket, number>>,
    icUnverified: flags?.icUnverified ?? 0,
    needsReview: flags?.needsReview ?? 0,
    total: flags?.total ?? 0,
  };
}

/** CSV 取込(1-10)用。社員番号で既存の登録者を引く(全拠点。範囲は呼び出し側で確かめる) */
export async function findPersonsByEmployeeCodes(tx: Tx, codes: readonly string[]) {
  if (codes.length === 0) return [];
  return tx
    .select({
      id: persons.id,
      siteId: persons.siteId,
      employeeCode: persons.employeeCode,
      name: persons.name,
      nameKana: persons.nameKana,
      phone: persons.phone,
      nationality: persons.nationality,
      birthDate: persons.birthDate,
      hiredAt: persons.hiredAt,
      status: persons.status,
    })
    .from(persons)
    .where(inArray(persons.employeeCode, [...codes]));
}

/** カード登録時に、登録者の生年月日・国籍が空欄ならカードの値で埋める(入力済みの値は変えない) */
export async function fillPersonFromCard(tx: Tx, id: string, v: { birthDate: string | null; nationality: string | null }): Promise<string[]> {
  const set: Record<string, unknown> = {};
  if (v.birthDate) set.birthDate = sql`coalesce(${persons.birthDate}, ${v.birthDate}::date)`;
  if (v.nationality && /^[A-Z]{3}$/.test(v.nationality)) set.nationality = sql`coalesce(${persons.nationality}, ${v.nationality})`;
  if (Object.keys(set).length === 0) return [];
  const [before] = await tx.select({ birthDate: persons.birthDate, nationality: persons.nationality }).from(persons).where(eq(persons.id, id));
  await tx.update(persons).set(set).where(eq(persons.id, id));
  return Object.keys(set).filter((k) => before && before[k as "birthDate" | "nationality"] === null);
}

// ---------------------------------------------------------------- 在籍期間・同一人物の照合

/** SQL 側で personMatchName と同じそろえ方をする(NFKC・大文字・空白と区切り記号) */
export const matchNameSql = sql<string>`trim(regexp_replace(upper(normalize(${persons.name}, NFKC)), '[[:space:],.・]+', ' ', 'g'))`;

export async function insertEmployment(
  tx: Tx,
  v: { personId: string; hiredAt: string | null; retiredAt: string; reasonCode: string; reasonNote: string | null; siteId: string; recordedBy: string },
): Promise<void> {
  await tx.insert(personEmployments).values(v);
}

export async function listEmployments(tx: Tx, personIds: readonly string[]) {
  if (personIds.length === 0) return [];
  return tx
    .select({
      personId: personEmployments.personId,
      hiredAt: personEmployments.hiredAt,
      retiredAt: personEmployments.retiredAt,
      reasonCode: personEmployments.reasonCode,
      reasonNote: personEmployments.reasonNote,
      siteName: sites.name,
    })
    .from(personEmployments)
    .leftJoin(sites, eq(sites.id, personEmployments.siteId))
    .where(inArray(personEmployments.personId, [...personIds]))
    .orderBy(desc(personEmployments.retiredAt), desc(personEmployments.createdAt));
}

/**
 * 同一人物と思われる登録者(アーカイブを除く)。
 * 氏名が同じで生年月日が同じ(片方が未入力なら氏名だけ)、またはフリガナと生年月日が同じ人
 */
export async function findSimilarPersons(
  tx: Tx,
  q: { matchName: string; nameKana?: string | null | undefined; birthDate?: string | null | undefined; excludeId?: string | undefined },
) {
  const byName = and(
    sql`${matchNameSql} = ${q.matchName}`,
    q.birthDate ? or(isNull(persons.birthDate), eq(persons.birthDate, q.birthDate)) : undefined,
  );
  const byKana = q.nameKana && q.birthDate ? and(eq(persons.nameKana, q.nameKana), eq(persons.birthDate, q.birthDate)) : undefined;
  return tx
    .select({
      id: persons.id,
      siteId: persons.siteId,
      siteName: sites.name,
      employeeCode: persons.employeeCode,
      name: persons.name,
      birthDate: persons.birthDate,
      status: persons.status,
      retiredAt: persons.retiredAt,
    })
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .where(and(ne(persons.status, "archived"), q.excludeId ? ne(persons.id, q.excludeId) : undefined, or(byName, byKana)))
    .orderBy(asc(persons.employeeCode))
    .limit(20);
}

/**
 * 二重登録の疑い: 在籍中の登録者で、氏名と生年月日(またはフリガナと生年月日)が同じ組。
 * scope の拠点の人を 1 人以上含む組だけ返す
 */
export async function listDuplicateGroups(tx: Tx, scope: SiteScope) {
  const key = sql<string>`coalesce(${matchNameSql}, '') || '|' || ${persons.birthDate}::text`;
  const kanaKey = sql<string>`${persons.nameKana} || '|' || ${persons.birthDate}::text`;
  const rows = await tx
    .select({
      id: persons.id,
      siteId: persons.siteId,
      siteName: sites.name,
      employeeCode: persons.employeeCode,
      name: persons.name,
      birthDate: persons.birthDate,
      hiredAt: persons.hiredAt,
      key,
      kanaKey,
    })
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .where(and(eq(persons.status, "active"), isNotNull(persons.birthDate)));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    for (const k of [r.key, r.kanaKey ? `kana:${r.kanaKey}` : null]) {
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
  }
  // 同じ組を氏名とフリガナの両方で数えないよう、メンバーの ID の組でまとめる
  const seen = new Set<string>();
  const out: { members: Omit<(typeof rows)[number], "key" | "kanaKey">[] }[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = members.map((m) => m.id).sort().join(",");
    if (seen.has(ids)) continue;
    seen.add(ids);
    if (scope !== null && !members.some((m) => scope.includes(m.siteId))) continue;
    out.push({ members: members.map(({ key: _k, kanaKey: _kk, ...m }) => m) });
  }
  return out;
}
