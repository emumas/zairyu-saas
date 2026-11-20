/** ダッシュボード(1-12 の API 部分): 期限区分ごとの件数。一覧は persons.list の expiryBuckets で取る */
import { countByExpiry, countOpenAlerts } from "@zairyu/db";
import { EXPIRY_BUCKETS, jstDate } from "@zairyu/shared";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { can, siteScope } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";

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
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        if (input.siteId) assertSiteAccess(ctx.actor, input.siteId);
        const today = jstDate(ctx.services.now());
        const r = await countByExpiry(tx, siteScope(ctx.actor), today, input.siteId);
        const buckets = Object.fromEntries(EXPIRY_BUCKETS.map((b) => [b, r.buckets[b] ?? 0])) as Record<(typeof EXPIRY_BUCKETS)[number], number>;
        const openAlerts = can(ctx.actor.role, "alerts.read") ? await countOpenAlerts(tx, siteScope(ctx.actor), input.siteId) : null;
        return { today, total: r.total, buckets, icUnverified: r.icUnverified, needsReview: r.needsReview, openAlerts };
      }),
    ),
});
