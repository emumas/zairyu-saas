/**
 * 退職後データの自動削除(1-21)。withPurge のトランザクションで呼ぶこと。
 * zairyu_purge ロールは全テナントの行が見える(RLS は USING true)ため、すべての条件で tenant_id を必ず指定する。
 *
 * 対象: 退職・アーカイブした登録者のうち、退職日(無ければアーカイブ日)からテナントの保存期間(3〜5 年)が過ぎた人。
 * 消すもの: 登録者・カード・カード画像(行。ファイルは呼び出し側で消す)・確認履歴・アラート・就労時間・在籍期間の履歴。
 * 監査ログは値を含まない(ID だけ)ので残す。日次人数・請求も人に結び付かないので残す
 */
import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { alerts, auditLogs, cardImages, platformAuditLogs, personEmployments, persons, residenceCards, tenants, studyBreaks, verifications, workDays, workHours } from "../schema.js";

export async function tenantsForPurge(tx: Tx) {
  return tx.select({ id: tenants.id, retentionYears: tenants.retentionYears, auditRetentionYears: tenants.auditRetentionYears }).from(tenants);
}

/** 保存期間が過ぎた登録者(today は JST の YYYY-MM-DD)。1 回に limit 人まで */
export async function expiredPersons(tx: Tx, tenantId: string, retentionYears: number, today: string, limit = 500) {
  const base = sql`coalesce(${persons.retiredAt}, (${persons.archivedAt} at time zone 'Asia/Tokyo')::date)`;
  return tx
    .select({ id: persons.id, retiredAt: sql<string>`${base}::text` })
    .from(persons)
    .where(
      and(
        eq(persons.tenantId, tenantId),
        inArray(persons.status, ["retired", "archived"]),
        sql`${base} + make_interval(years => ${retentionYears}) < ${today}::date`,
      ),
    )
    .orderBy(persons.id)
    .limit(limit);
}

/** 登録者と関連データの行を消し、消すべき画像ファイルのキーを返す */
export async function deletePersonsData(tx: Tx, tenantId: string, personIds: readonly string[]) {
  if (personIds.length === 0) return { blobKeys: [] as string[], cards: 0, images: 0, verifications: 0 };
  const ids = [...personIds];
  const cards = (
    await tx
      .select({ id: residenceCards.id })
      .from(residenceCards)
      .where(and(eq(residenceCards.tenantId, tenantId), inArray(residenceCards.personId, ids)))
  ).map((c) => c.id);
  const images = cards.length
    ? await tx
        .delete(cardImages)
        .where(and(eq(cardImages.tenantId, tenantId), inArray(cardImages.cardId, cards)))
        .returning({ blobKey: cardImages.blobKey })
    : [];
  const vs = cards.length
    ? await tx
        .delete(verifications)
        .where(and(eq(verifications.tenantId, tenantId), inArray(verifications.cardId, cards)))
        .returning({ id: verifications.id })
    : [];
  await tx
    .delete(alerts)
    .where(and(eq(alerts.tenantId, tenantId), or(inArray(alerts.personId, ids), cards.length ? inArray(alerts.cardId, cards) : sql`false`)));
  await tx.delete(workHours).where(and(eq(workHours.tenantId, tenantId), inArray(workHours.personId, ids)));
  await tx.delete(workDays).where(and(eq(workDays.tenantId, tenantId), inArray(workDays.personId, ids)));
  await tx.delete(studyBreaks).where(and(eq(studyBreaks.tenantId, tenantId), inArray(studyBreaks.personId, ids)));
  await tx.delete(personEmployments).where(and(eq(personEmployments.tenantId, tenantId), inArray(personEmployments.personId, ids)));
  if (cards.length) await tx.delete(residenceCards).where(and(eq(residenceCards.tenantId, tenantId), inArray(residenceCards.id, cards)));
  await tx.delete(persons).where(and(eq(persons.tenantId, tenantId), inArray(persons.id, ids)));
  return { blobKeys: images.map((i) => i.blobKey), cards: cards.length, images: images.length, verifications: vs.length };
}

/** keys のうち、カード画像として記録されているもの(孤立したファイルの掃除用) */
export async function referencedBlobKeys(tx: Tx, tenantId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ key: cardImages.blobKey })
    .from(cardImages)
    .where(and(eq(cardImages.tenantId, tenantId), inArray(cardImages.blobKey, [...keys])));
  return new Set(rows.map((r) => r.key));
}

/** 運営者の操作記録の保存期間(年)。テナントに属さないので一律 */
export const PLATFORM_AUDIT_RETENTION_YEARS = 10;

/**
 * 保存期間が過ぎた監査ログを消す(古い順に limit 件まで。多いときは繰り返し呼ぶ)。
 * before は JST の日付で、この日の 0 時より前の記録が対象
 */
export async function deleteExpiredAuditLogs(tx: Tx, tenantId: string, before: string, limit = 5000): Promise<number> {
  const cutoff = new Date(`${before}T00:00:00+09:00`);
  const ids = tx
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.at, cutoff)))
    .orderBy(auditLogs.id)
    .limit(limit);
  const r = await tx.delete(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), inArray(auditLogs.id, ids))).returning({ id: auditLogs.id });
  return r.length;
}

export async function countExpiredAuditLogs(tx: Tx, tenantId: string, before: string): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.at, new Date(`${before}T00:00:00+09:00`))));
  return r?.n ?? 0;
}

export async function deleteExpiredPlatformAuditLogs(tx: Tx, before: string, limit = 5000): Promise<number> {
  const l = platformAuditLogs;
  const cutoff = new Date(`${before}T00:00:00+09:00`);
  const ids = tx.select({ id: l.id }).from(l).where(lt(l.at, cutoff)).orderBy(l.id).limit(limit);
  const r = await tx.delete(l).where(inArray(l.id, ids)).returning({ id: l.id });
  return r.length;
}

export async function countExpiredPlatformAuditLogs(tx: Tx, before: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(platformAuditLogs).where(lt(platformAuditLogs.at, new Date(`${before}T00:00:00+09:00`)));
  return r?.n ?? 0;
}
