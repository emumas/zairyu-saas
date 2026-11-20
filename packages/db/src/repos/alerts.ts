/** アラートと通知のリポジトリ(withTenant のトランザクションで呼ぶこと) */
import type { NotificationPayload } from "@zairyu/shared";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { alerts, notificationOutbox, persons, residenceCards, sites, userDevices, userSites, users } from "../schema.js";
import type { SiteScope } from "./persons.js";

type AlertType = (typeof alerts.$inferInsert)["type"];

/** 在籍中の登録者と現在のカード(アラート判定用) */
export async function activeCardsForAlerts(tx: Tx) {
  return tx
    .select({
      personId: persons.id,
      siteId: persons.siteId,
      card: {
        id: residenceCards.id,
        expiryDate: residenceCards.expiryDate,
        cardValidUntil: residenceCards.cardValidUntil,
        pendingApplication: residenceCards.pendingApplication,
        icVerified: residenceCards.icVerified,
        needsReview: residenceCards.needsReview,
      },
    })
    .from(persons)
    .leftJoin(residenceCards, and(eq(residenceCards.personId, persons.id), eq(residenceCards.isCurrent, true)))
    .where(eq(persons.status, "active"));
}

/** まだ無いアラートだけを作り、作ったものを返す(同じ人・種類・期日は 1 件だけ) */
export async function insertAlertsIfAbsent(
  tx: Tx,
  rows: { personId: string; cardId: string | null; type: AlertType; dueDate: string }[],
) {
  if (rows.length === 0) return [];
  return tx
    .insert(alerts)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: alerts.id, personId: alerts.personId, type: alerts.type });
}

export async function markAlertsQueued(tx: Tx, ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(alerts).set({ sentAt: at }).where(inArray(alerts.id, ids));
}

/** 拠点の通知先: テナント管理者と、その拠点の拠点管理者(有効なユーザーのみ) */
export async function alertRecipients(tx: Tx, siteId: string): Promise<{ id: string }[]> {
  return tx
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(userSites, and(eq(userSites.userId, users.id), eq(userSites.siteId, siteId)))
    .where(
      and(
        eq(users.status, "active"),
        or(eq(users.role, "tenant_admin"), and(eq(users.role, "site_admin"), eq(userSites.siteId, siteId))),
      ),
    );
}

export async function enqueueNotifications(
  tx: Tx,
  userIds: readonly string[],
  payload: NotificationPayload,
  at: Date,
  channels: readonly ("push" | "email")[] = ["push", "email"],
): Promise<void> {
  const rows = userIds.flatMap((userId) => channels.map((channel) => ({ userId, channel, payload, nextAttemptAt: at })));
  if (rows.length > 0) await tx.insert(notificationOutbox).values(rows);
}

/** 送信期限が来た通知(同時に動く送信ジョブと取り合わないようロックする) */
export async function lockDueNotifications(tx: Tx, now: Date, limit = 100) {
  return tx
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      channel: notificationOutbox.channel,
      payload: notificationOutbox.payload,
      attempts: notificationOutbox.attempts,
      email: users.email,
    })
    .from(notificationOutbox)
    .innerJoin(users, eq(users.id, notificationOutbox.userId))
    .where(and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.nextAttemptAt, now)))
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true, of: notificationOutbox });
}

export async function markNotification(
  tx: Tx,
  id: string,
  r: { status: "sent" | "failed" | "pending"; attempts: number; nextAttemptAt?: Date; sentAt?: Date; lastError?: string | null },
): Promise<void> {
  await tx
    .update(notificationOutbox)
    .set({
      status: r.status,
      attempts: r.attempts,
      ...(r.nextAttemptAt ? { nextAttemptAt: r.nextAttemptAt } : {}),
      ...(r.sentAt ? { sentAt: r.sentAt } : {}),
      lastError: r.lastError ?? null,
    })
    .where(eq(notificationOutbox.id, id));
}

export async function pushTokensFor(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.select({ t: userDevices.expoPushToken }).from(userDevices).where(eq(userDevices.userId, userId));
  return rows.map((r) => r.t);
}

export async function removePushToken(tx: Tx, token: string): Promise<void> {
  await tx.delete(userDevices).where(eq(userDevices.expoPushToken, token));
}

/** 端末のトークンを登録する(同じトークンが別ユーザーにあれば付け替える) */
export async function upsertPushToken(tx: Tx, userId: string, platform: string, token: string): Promise<void> {
  await tx
    .insert(userDevices)
    .values({ userId, platform, expoPushToken: token })
    .onConflictDoUpdate({ target: userDevices.expoPushToken, set: { userId, platform, lastSeenAt: new Date() } });
}

// ---------------------------------------------------------------- 一覧と対応

export async function listAlerts(tx: Tx, scope: SiteScope, q: { open: boolean; limit: number; offset: number }) {
  const conds = [
    scope === null ? undefined : scope.length === 0 ? sql`false` : inArray(persons.siteId, [...scope]),
    q.open ? isNull(alerts.acknowledgedAt) : undefined,
  ];
  return tx
    .select({
      id: alerts.id,
      type: alerts.type,
      dueDate: alerts.dueDate,
      createdAt: alerts.createdAt,
      acknowledgedAt: alerts.acknowledgedAt,
      person: { id: persons.id, name: persons.name, employeeCode: persons.employeeCode, siteName: sites.name },
    })
    .from(alerts)
    .innerJoin(persons, eq(persons.id, alerts.personId))
    .innerJoin(sites, eq(sites.id, persons.siteId))
    .where(and(...conds))
    .orderBy(desc(alerts.dueDate), desc(alerts.createdAt))
    .limit(q.limit)
    .offset(q.offset);
}

/** 未対応のアラートの件数(ダッシュボード用。siteId を指定すればその拠点だけ) */
export async function countOpenAlerts(tx: Tx, scope: SiteScope, siteId?: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(alerts)
    .innerJoin(persons, eq(persons.id, alerts.personId))
    .where(
      and(
        isNull(alerts.acknowledgedAt),
        scope === null ? undefined : scope.length === 0 ? sql`false` : inArray(persons.siteId, [...scope]),
        siteId ? eq(persons.siteId, siteId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

export async function findAlertSite(tx: Tx, id: string): Promise<{ siteId: string; acknowledgedAt: Date | null } | null> {
  const [row] = await tx
    .select({ siteId: persons.siteId, acknowledgedAt: alerts.acknowledgedAt })
    .from(alerts)
    .innerJoin(persons, eq(persons.id, alerts.personId))
    .where(eq(alerts.id, id));
  return row ?? null;
}

export async function acknowledgeAlert(tx: Tx, id: string, userId: string, at: Date): Promise<void> {
  await tx.update(alerts).set({ acknowledgedBy: userId, acknowledgedAt: at }).where(eq(alerts.id, id));
}
