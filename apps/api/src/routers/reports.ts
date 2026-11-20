/**
 * 確認履歴・監査ログの出力(1-14)。テナント管理者のみ(reports.export)。
 * 期間は JST の日付で受け取る(開始日 0 時〜終了日の翌日 0 時)。CSV / 印刷用の表は Web で組み立てる。
 * 出力したことを監査ログに残す(条件と件数のみ)
 */
import { EXPORT_LIMIT, listAuditLogsForExport, listVerificationsForExport } from "@zairyu/db";
import { addDays, daysBetween, dateString } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { permissionProcedure, router } from "../trpc.js";

const MAX_DAYS = 366;

const period = z
  .object({ from: dateString, to: dateString })
  .refine((p) => p.from <= p.to, { message: "開始日は終了日以前にしてください" })
  .refine((p) => daysBetween(p.from, p.to) < MAX_DAYS, { message: "期間は 1 年以内にしてください" });

/** JST の日付の範囲を時刻の範囲にする */
const range = (p: { from: string; to: string }) => ({ from: new Date(`${p.from}T00:00:00+09:00`), to: new Date(`${addDays(p.to, 1)}T00:00:00+09:00`) });

function assertLimit(n: number) {
  if (n > EXPORT_LIMIT) throw new TRPCError({ code: "BAD_REQUEST", message: `${EXPORT_LIMIT} 件を超えます。期間を分けて出力してください` });
}

export const reportsRouter = router({
  verifications: permissionProcedure("reports.export")
    .input(z.object({ period, siteId: z.uuid().optional() }))
    .output(
      z.object({
        rows: z.array(
          z.object({
            performedAt: z.date(),
            employeeCode: z.string(),
            personName: z.string(),
            siteName: z.string(),
            cardFormat: z.string(),
            method: z.string(),
            result: z.string(),
            note: z.string().nullable(),
            performedByEmail: z.string().nullable(),
          }),
        ),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const rows = await listVerificationsForExport(tx, { ...range(input.period), siteId: input.siteId });
        assertLimit(rows.length);
        await ctx.audit(tx, { action: "report.verifications_export", detail: { ...input.period, siteId: input.siteId ?? null, count: rows.length } });
        return { rows };
      }),
    ),

  auditLogs: permissionProcedure("reports.export")
    .input(z.object({ period }))
    .output(
      z.object({
        rows: z.array(
          z.object({
            at: z.date(),
            actorEmail: z.string().nullable(),
            action: z.string(),
            targetType: z.string().nullable(),
            targetId: z.string().nullable(),
            detail: z.unknown(),
            ip: z.string().nullable(),
          }),
        ),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const rows = await listAuditLogsForExport(tx, range(input.period));
        assertLimit(rows.length);
        await ctx.audit(tx, { action: "report.audit_logs_export", detail: { ...input.period, count: rows.length } });
        return { rows };
      }),
    ),
});
