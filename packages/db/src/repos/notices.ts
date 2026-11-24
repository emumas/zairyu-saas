/**
 * 外国人雇用状況の届出(第1段階)。届出が必要な出来事(雇入れ・離職)は登録者の入社日と在籍期間の履歴から求め、
 * employment_notices には提出した/不要とした記録だけを置く
 */
import { and, eq, gte, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { employmentNotices, personEmployments, persons, residenceCards, sites, tenants } from "../schema.js";
import { noticeDueDate } from "@zairyu/shared";
import type { SiteScope } from "./persons.js";

const scopeCondition = (scope: SiteScope): SQL | undefined =>
  scope === null ? undefined : scope.length === 0 ? sql`false` : inArray(persons.siteId, [...scope]);

export interface NoticeEvent {
  personId: string;
  kind: "hire" | "separation";
  eventDate: string;
  siteId: string;
}

/** from 以後の雇入れ・離職(アーカイブした登録者は除く) */
export async function listNoticeEvents(tx: Tx, scope: SiteScope, from: string): Promise<NoticeEvent[]> {
  const current = await tx
    .select({ personId: persons.id, eventDate: persons.hiredAt, siteId: persons.siteId })
    .from(persons)
    .where(and(ne(persons.status, "archived"), isNotNull(persons.hiredAt), gte(persons.hiredAt, from), scopeCondition(scope)));
  const history = await tx
    .select({ personId: personEmployments.personId, hiredAt: personEmployments.hiredAt, retiredAt: personEmployments.retiredAt, siteId: sql<string>`coalesce(${personEmployments.siteId}, ${persons.siteId})` })
    .from(personEmployments)
    .innerJoin(persons, eq(persons.id, personEmployments.personId))
    .where(and(ne(persons.status, "archived"), or(gte(personEmployments.hiredAt, from), gte(personEmployments.retiredAt, from)), scopeCondition(scope)));
  const out = new Map<string, NoticeEvent>();
  const add = (e: NoticeEvent) => out.set(`${e.personId}|${e.kind}|${e.eventDate}`, e);
  for (const c of current) add({ personId: c.personId, kind: "hire", eventDate: c.eventDate!, siteId: c.siteId });
  for (const h of history) {
    if (h.hiredAt && h.hiredAt >= from) add({ personId: h.personId, kind: "hire", eventDate: h.hiredAt, siteId: h.siteId });
    if (h.retiredAt >= from) add({ personId: h.personId, kind: "separation", eventDate: h.retiredAt, siteId: h.siteId });
  }
  return [...out.values()];
}

/** 届出に書く登録者と今のカードの情報 */
export async function noticePersons(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: persons.id,
      employeeCode: persons.employeeCode,
      name: persons.name,
      nameKana: persons.nameKana,
      personBirthDate: persons.birthDate,
      personNationality: persons.nationality,
      employmentInsured: persons.employmentInsured,
      status: persons.status,
      card: {
        id: residenceCards.id,
        cardKind: residenceCards.cardKind,
        statusOfResidence: residenceCards.statusOfResidence,
        expiryDate: residenceCards.expiryDate,
        cardValidUntil: residenceCards.cardValidUntil,
        birthDate: residenceCards.birthDate,
        sex: residenceCards.sex,
        nationality: residenceCards.nationality,
        outsideActivity: residenceCards.outsideActivity,
        outsideActivityUntil: residenceCards.outsideActivityUntil,
        cardNumberEnc: residenceCards.cardNumberEnc,
      },
    })
    .from(persons)
    .leftJoin(residenceCards, and(eq(residenceCards.personId, persons.id), eq(residenceCards.isCurrent, true)))
    .where(inArray(persons.id, [...ids]));
}

export async function listNoticeRecords(tx: Tx, personIds: readonly string[]) {
  if (personIds.length === 0) return [];
  return tx.select().from(employmentNotices).where(inArray(employmentNotices.personId, [...personIds]));
}

export async function upsertNoticeRecord(
  tx: Tx,
  v: {
    personId: string;
    kind: "hire" | "separation";
    eventDate: string;
    status: "submitted" | "not_required";
    submittedOn: string | null;
    method: string | null;
    receiptNo: string | null;
    note: string | null;
    recordedBy: string;
  },
): Promise<void> {
  await tx
    .insert(employmentNotices)
    .values(v)
    .onConflictDoUpdate({
      target: [employmentNotices.personId, employmentNotices.kind, employmentNotices.eventDate],
      set: { status: v.status, submittedOn: v.submittedOn, method: v.method, receiptNo: v.receiptNo, note: v.note, recordedBy: v.recordedBy, updatedAt: new Date() },
    });
}

export async function deleteNoticeRecord(tx: Tx, personId: string, kind: string, eventDate: string): Promise<boolean> {
  const r = await tx
    .delete(employmentNotices)
    .where(and(eq(employmentNotices.personId, personId), eq(employmentNotices.kind, kind), eq(employmentNotices.eventDate, eventDate)))
    .returning({ id: employmentNotices.id });
  return r.length > 0;
}

export async function getEmployerInfo(tx: Tx) {
  const [t] = await tx
    .select({
      name: tenants.employerName,
      tenantName: tenants.name,
      address: tenants.employerAddress,
      phone: tenants.employerPhone,
      representativeName: tenants.representativeName,
      noticesFrom: sql<string>`${tenants.noticesFrom}::text`,
    })
    .from(tenants);
  return t ?? null;
}

export async function siteInfo(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({ id: sites.id, name: sites.name, officialName: sites.officialName, address: sites.address, phone: sites.phone, insuranceOfficeNumber: sites.insuranceOfficeNumber })
    .from(sites)
    .where(inArray(sites.id, [...ids]));
}

/**
 * 期限が 7 日以内か過ぎた未提出の届出(期限のアラート用。テナント全体)。
 * 特別永住者は届出の対象外なので除く
 */
export async function noticesDueSoon(tx: Tx, today: string, withinDays = 7) {
  const employer = await getEmployerInfo(tx);
  if (!employer) return [];
  const events = await listNoticeEvents(tx, null, employer.noticesFrom);
  const ids = [...new Set(events.map((e) => e.personId))];
  const people = new Map((await noticePersons(tx, ids)).map((p) => [p.id, p]));
  const done = new Set((await listNoticeRecords(tx, ids)).map((r) => `${r.personId}|${r.kind}|${r.eventDate}`));
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000).toISOString().slice(0, 10);
  return events.flatMap((e) => {
    const p = people.get(e.personId);
    if (!p || p.card?.cardKind === "special_permanent" || done.has(`${e.personId}|${e.kind}|${e.eventDate}`)) return [];
    const dueDate = noticeDueDate(e.kind, e.eventDate, p.employmentInsured);
    return dueDate <= limit ? [{ personId: e.personId, siteId: e.siteId, kind: e.kind, eventDate: e.eventDate, dueDate, overdue: dueDate < today }] : [];
  });
}
