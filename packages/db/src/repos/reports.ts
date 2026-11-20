/** 確認履歴・監査ログの出力(1-14)。withTenant のトランザクションで呼ぶこと */
import { and, asc, eq, gte, lt, type SQL } from "drizzle-orm";
import type { Tx } from "../client.js";
import { auditLogs, persons, residenceCards, sites, users, verifications } from "../schema.js";

/** 出力できる最大件数(これを超えたら期間を分けてもらう) */
export const EXPORT_LIMIT = 20_000;

export async function listVerificationsForExport(tx: Tx, q: { from: Date; to: Date; siteId?: string | undefined }) {
  const conds: SQL[] = [gte(verifications.performedAt, q.from), lt(verifications.performedAt, q.to)];
  if (q.siteId) conds.push(eq(persons.siteId, q.siteId));
  return tx
    .select({
      performedAt: verifications.performedAt,
      employeeCode: persons.employeeCode,
      personName: persons.name,
      siteName: sites.name,
      cardFormat: residenceCards.cardFormat,
      method: verifications.method,
      result: verifications.result,
      note: verifications.note,
      performedByEmail: users.email,
    })
    .from(verifications)
    .innerJoin(residenceCards, eq(residenceCards.id, verifications.cardId))
    .innerJoin(persons, eq(persons.id, residenceCards.personId))
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .leftJoin(users, eq(users.id, verifications.performedBy))
    .where(and(...conds))
    .orderBy(asc(verifications.performedAt), asc(verifications.id))
    .limit(EXPORT_LIMIT + 1);
}

export async function listAuditLogsForExport(tx: Tx, q: { from: Date; to: Date }) {
  return tx
    .select({
      at: auditLogs.at,
      actorEmail: users.email,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      detail: auditLogs.detail,
      ip: auditLogs.ip,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(gte(auditLogs.at, q.from), lt(auditLogs.at, q.to)))
    .orderBy(asc(auditLogs.at), asc(auditLogs.id))
    .limit(EXPORT_LIMIT + 1);
}
