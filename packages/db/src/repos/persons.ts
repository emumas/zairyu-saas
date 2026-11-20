/**
 * 登録者のリポジトリ。拠点の範囲(scope)は呼び出し側(権限ミドルウェア)が決め、ここで必ず SQL に反映する。
 * テナントの絞り込みは RLS が行う(withTenant のトランザクションで呼ぶこと)。
 */
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { persons, residenceCards, sites } from "../schema.js";

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
}

const summaryColumns = {
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
};

function scopeCondition(scope: SiteScope): SQL | undefined {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  return inArray(persons.siteId, [...scope]);
}

/** LIKE のワイルドカードを無効にする */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPersons(tx: Tx, q: PersonListQuery) {
  const conds: (SQL | undefined)[] = [
    scopeCondition(q.scope),
    inArray(persons.status, [...(q.statuses ?? ["active", "retired"])]),
  ];
  if (q.siteId) conds.push(eq(persons.siteId, q.siteId));
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
    .select(summaryColumns)
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .leftJoin(residenceCards, and(eq(residenceCards.personId, persons.id), eq(residenceCards.isCurrent, true)))
    .where(where)
    .orderBy(...order)
    .limit(q.limit)
    .offset(q.offset);
  const [total] = await tx.select({ n: count() }).from(persons).where(where);
  return { items, total: total?.n ?? 0 };
}

export async function getPerson(tx: Tx, id: string, scope: SiteScope) {
  const [row] = await tx
    .select(summaryColumns)
    .from(persons)
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .leftJoin(residenceCards, and(eq(residenceCards.personId, persons.id), eq(residenceCards.isCurrent, true)))
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
