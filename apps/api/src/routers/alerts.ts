/** アラート(1-13): 一覧と対応済みにする操作 */
import { acknowledgeAlert, findAlertSite, listAlerts } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { siteScope } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";

export const alertsRouter = router({
  list: permissionProcedure("alerts.read")
    .input(z.object({ open: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).default({ open: true, limit: 50, offset: 0 }))
    .output(
      z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          dueDate: z.string(),
          createdAt: z.date(),
          acknowledgedAt: z.date().nullable(),
          person: z.object({ id: z.string(), name: z.string(), employeeCode: z.string(), siteName: z.string() }),
        }),
      ),
    )
    .query(({ ctx, input }) => ctx.tenantTx((tx) => listAlerts(tx, siteScope(ctx.actor), input))),

  acknowledge: permissionProcedure("alerts.ack")
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const a = await findAlertSite(tx, input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });
        assertSiteAccess(ctx.actor, a.siteId);
        if (a.acknowledgedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "すでに対応済みです" });
        await acknowledgeAlert(tx, input.id, ctx.actor.userId, new Date(ctx.services.now()));
        await ctx.audit(tx, { action: "alert.acknowledge", targetType: "alert", targetId: input.id });
        return { id: input.id };
      }),
    ),
});
