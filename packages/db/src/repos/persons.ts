/**
 * 登録者のリポジトリ。拠点の範囲(scope)は呼び出し側(権限ミドルウェア)が決め、ここで必ず SQL に反映する。
 * テナントの絞り込みは RLS が行う(withTenant のトランザクションで呼ぶこと)。
 */
import type { ExpiryBucket } from "@zairyu/shared";
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { persons, residenceCards, sites } from "../schema.js";
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
  nationality: persons.nationality,
  birthDate: persons.birthDate,
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
    conds.push(or(ilike(persons.name, `%${e}%`), ilike(persons.employeeCode, `${e}%`)));
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
  input: { siteId: string; employeeCode: string; name: string; nationality?: string | null | undefined; birthDate?: string | null | undefined },
) {
  const [row] = await tx
    .insert(persons)
    .values({
      siteId: input.siteId,
      employeeCode: input.employeeCode,
      name: input.name,
      nationality: input.nationality ?? null,
      birthDate: input.birthDate ?? null,
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
  patch: Partial<{ siteId: string; employeeCode: string; name: string; nationality: string | null; birthDate: string | null }>,
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
