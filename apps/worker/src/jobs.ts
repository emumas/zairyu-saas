/**
 * 定期ジョブ(1-13)
 * - generateAlerts: 毎日深夜(JST)。期限アラートを作り、通知を送信待ちに積む
 * - sendNotifications: 数分おき。送信待ちの通知を送り、失敗は間隔を空けて再送(最大 5 回)
 */
import {
  activeCardsForAlerts,
  alertRecipients,
  enqueueNotifications,
  insertAlertsIfAbsent,
  lockDueNotifications,
  markAlertsQueued,
  markNotification,
  noticesDueSoon,
  pushTokensFor,
  removePushToken,
  schema,
  withPlatform,
  withTenant,
  type Db,
} from "@zairyu/db";
import { expiryAlertFor, expiryDigest, jstDate, noticeDueDigest, type ExpiryAlertType, type NotificationPayload } from "@zairyu/shared";
import { ne } from "drizzle-orm";
import type { Notifier } from "./notifiers.js";

export const MAX_ATTEMPTS = 5;

/** 対象テナント(契約停止中は除く。未払いでも期限アラートは止めない: DESIGN.md 6章) */
export async function activeTenantIds(db: Db): Promise<string[]> {
  const rows = await withPlatform(db, (tx) => tx.select({ id: schema.tenants.id }).from(schema.tenants).where(ne(schema.tenants.status, "suspended")));
  return rows.map((r) => r.id);
}

export async function generateAlerts(db: Db, tenantId: string, nowMs: number): Promise<{ created: number; notified: number }> {
  const today = jstDate(nowMs);
  return withTenant(db, tenantId, async (tx) => {
    const cards = await activeCardsForAlerts(tx);
    const candidates = cards.flatMap((c) => {
      const a = expiryAlertFor(c.card, today);
      return a ? [{ personId: c.personId, cardId: c.card?.id ?? null, type: a.type, dueDate: a.dueDate, siteId: c.siteId }] : [];
    });
    const created = await insertAlertsIfAbsent(
      tx,
      candidates.map(({ siteId: _s, ...r }) => r),
    );
    if (created.length === 0) return { created: 0, notified: 0 };

    // 受け取る人ごとに件数を数えて 1 通にまとめる
    const siteOf = new Map(candidates.map((c) => [c.personId, c.siteId]));
    const perUser = new Map<string, Partial<Record<ExpiryAlertType, number>>>();
    const recipientsBySite = new Map<string, string[]>();
    for (const a of created) {
      const siteId = siteOf.get(a.personId)!;
      if (!recipientsBySite.has(siteId)) recipientsBySite.set(siteId, (await alertRecipients(tx, siteId)).map((r) => r.id));
      for (const userId of recipientsBySite.get(siteId)!) {
        const counts = perUser.get(userId) ?? {};
        const t = a.type as ExpiryAlertType;
        counts[t] = (counts[t] ?? 0) + 1;
        perUser.set(userId, counts);
      }
    }
    for (const [userId, counts] of perUser) {
      const payload = expiryDigest(counts);
      if (payload) await enqueueNotifications(tx, [userId], payload, new Date(nowMs));
    }
    await markAlertsQueued(
      tx,
      created.map((a) => a.id),
      new Date(nowMs),
    );
    return { created: created.length, notified: perUser.size };
  });
}

/**
 * 外国人雇用状況の届出の期限のアラート(毎日)。期限が 7 日以内か過ぎた未提出の届出ごとに 1 件(同じ届出は 1 度だけ)作り、
 * 担当の拠点の管理者に件数だけのお知らせを送る(氏名は入れない)
 */
export async function generateNoticeAlerts(db: Db, tenantId: string, nowMs: number): Promise<{ created: number; notified: number }> {
  const today = jstDate(nowMs);
  return withTenant(db, tenantId, async (tx) => {
    const due = await noticesDueSoon(tx, today);
    const created = await insertAlertsIfAbsent(
      tx,
      due.map((d) => ({ personId: d.personId, cardId: null, type: "notice_due" as const, dueDate: d.dueDate })),
    );
    if (created.length === 0) return { created: 0, notified: 0 };
    const byKey = new Map(due.map((d) => [`${d.personId}|${d.dueDate}`, d]));
    const createdDue = created.flatMap((c) => byKey.get(`${c.personId}|${c.dueDate}`) ?? []);
    const perUser = new Map<string, { overdue: number; soon: number }>();
    const recipientsBySite = new Map<string, string[]>();
    for (const d of createdDue) {
      if (!recipientsBySite.has(d.siteId)) recipientsBySite.set(d.siteId, (await alertRecipients(tx, d.siteId)).map((r) => r.id));
      for (const userId of recipientsBySite.get(d.siteId)!) {
        const c = perUser.get(userId) ?? { overdue: 0, soon: 0 };
        if (d.overdue) c.overdue++;
        else c.soon++;
        perUser.set(userId, c);
      }
    }
    for (const [userId, counts] of perUser) {
      const payload = noticeDueDigest(counts);
      if (payload) await enqueueNotifications(tx, [userId], payload, new Date(nowMs));
    }
    await markAlertsQueued(
      tx,
      created.map((a) => a.id),
      new Date(nowMs),
    );
    return { created: created.length, notified: perUser.size };
  });
}

/** 再送の間隔: 1, 2, 4, 8 分 */
const backoffMs = (attempts: number) => 60_000 * 2 ** (attempts - 1);

export async function sendNotifications(db: Db, tenantId: string, notifier: Notifier, nowMs: number): Promise<{ sent: number; failed: number }> {
  return withTenant(db, tenantId, async (tx) => {
    const due = await lockDueNotifications(tx, new Date(nowMs));
    let sent = 0;
    let failed = 0;
    for (const n of due) {
      const payload = n.payload as NotificationPayload;
      let ok: boolean;
      let error: string | undefined;
      try {
        if (n.channel === "push") {
          const tokens = await pushTokensFor(tx, n.userId);
          if (tokens.length === 0) {
            // 端末未登録はエラーではない(メール側で届く)
            await markNotification(tx, n.id, { status: "sent", attempts: n.attempts + 1, sentAt: new Date(nowMs), lastError: "no_device" });
            sent++;
            continue;
          }
          const r = await notifier.push(tokens, payload);
          for (const t of r.invalidTokens) await removePushToken(tx, t);
          ok = r.ok;
          error = r.error;
        } else {
          const r = await notifier.email(n.email, payload);
          ok = r.ok;
          error = r.error;
        }
      } catch (e) {
        ok = false;
        // 例外メッセージには宛先などが入りうるため、種類だけ残す
        error = (e as Error).name || "error";
      }
      const attempts = n.attempts + 1;
      if (ok) {
        await markNotification(tx, n.id, { status: "sent", attempts, sentAt: new Date(nowMs) });
        sent++;
      } else {
        const giveUp = attempts >= MAX_ATTEMPTS;
        await markNotification(tx, n.id, {
          status: giveUp ? "failed" : "pending",
          attempts,
          nextAttemptAt: new Date(nowMs + backoffMs(attempts)),
          lastError: error ?? "error",
        });
        failed++;
      }
    }
    return { sent, failed };
  });
}
