/** ダッシュボード(1-12 の API 部分): 期限区分ごとの件数。一覧は persons.list の expiryBuckets で取る */
import { activePersonCards, countByExpiry, countOpenAlerts, listDuplicateGroups } from "@zairyu/db";
import { addDays, classifyExpiry, EXPIRY_BUCKETS, jstDate, judgeWorkEligibility, WORK_LEVELS, type WorkLevel } from "@zairyu/shared";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { can, siteScope } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";
import { weeklyChecks } from "./workHours.js";
import { noticeCounts } from "./notices.js";

export const dashboardRouter = router({
  summary: permissionProcedure("dashboard.read")
    .input(z.object({ siteId: z.uuid().optional() }).default({}))
    .output(
      z.object({
        /** 判定日(JST) */
        today: z.string(),
        /** 在籍中の登録者数 */
        total: z.number(),
        buckets: z.record(z.enum(EXPIRY_BUCKETS), z.number()),
        icUnverified: z.number(),
        needsReview: z.number(),
        /** 未対応のアラート(アラートを見る権限が無ければ null) */
        openAlerts: z.number().nullable(),
        /** 二重登録の疑いの組の数(登録者を編集できない人には null) */
        duplicateGroups: z.number().nullable(),
        /** 就労可否の区分ごとの件数(在籍中) */
        work: z.record(z.enum(WORK_LEVELS), z.number()),
        /** 週28時間の確認(今日までの 4 週間): 超過・注意の人数 */
        weeklyHours: z.object({ over: z.number(), near: z.number(), targets: z.number() }),
        /** 外国人雇用状況の届出の未提出(登録者を編集できない人には null) */
        notices: z.object({ overdue: z.number(), dueSoon: z.number(), pending: z.number() }).nullable(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        if (input.siteId) assertSiteAccess(ctx.actor, input.siteId);
        const today = jstDate(ctx.services.now());
        const r = await countByExpiry(tx, siteScope(ctx.actor), today, input.siteId);
        const buckets = Object.fromEntries(EXPIRY_BUCKETS.map((b) => [b, r.buckets[b] ?? 0])) as Record<(typeof EXPIRY_BUCKETS)[number], number>;
        const openAlerts = can(ctx.actor.role, "alerts.read") ? await countOpenAlerts(tx, siteScope(ctx.actor), input.siteId) : null;
        const duplicateGroups = can(ctx.actor.role, "persons.write") ? (await listDuplicateGroups(tx, siteScope(ctx.actor))).length : null;
        const work = Object.fromEntries(WORK_LEVELS.map((l) => [l, 0])) as Record<WorkLevel, number>;
        for (const p of await activePersonCards(tx, siteScope(ctx.actor), today, input.siteId)) {
          work[judgeWorkEligibility(p.card, classifyExpiry(p.card, today), today).level]++;
        }
        const checks = await weeklyChecks(tx, ctx.actor, today, { from: addDays(today, -27), to: today }, input.siteId);
        const weeklyHours = {
          over: checks.filter((c) => c.check.status === "over").length,
          near: checks.filter((c) => c.check.status === "near").length,
          targets: checks.length,
        };
        const notices = can(ctx.actor.role, "persons.write") ? await noticeCounts(tx, ctx.actor, ctx.services) : null;
        return { notices, weeklyHours, today, total: r.total, buckets, icUnverified: r.icUnverified, needsReview: r.needsReview, openAlerts, duplicateGroups, work };
      }),
    ),
});
