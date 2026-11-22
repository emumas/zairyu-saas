/**
 * 勤怠 CSV と週28時間の確認(フェーズ2)。
 * - importDays: 日ごとの労働時間を取り込む(同じ人・同じ日は上書き。CSV の同じ日の複数行は合計)
 * - list: 資格外活動(包括許可・週28時間)の在籍者ごとの判定
 * - person: 1 人分の日ごとの時間・長期休業期間・判定
 * 他の勤務先での労働時間も 28 時間に含まれるが、ここでは自社の勤怠だけを見る(画面で注意書きを出す)
 */
import {
  activePersonCards,
  deleteStudyBreak,
  findPersonsByEmployeeCodes,
  findStudyBreak,
  getPerson,
  insertStudyBreak,
  listStudyBreaks,
  listWorkDays,
  upsertWorkDays,
  type Tx,
} from "@zairyu/db";
import {
  addDays,
  checkWeeklyHours,
  classifyExpiry,
  jstDate,
  judgeWorkEligibility,
  studyBreakInput,
  workImportInput,
  workPeriodInput,
  type WeeklyCheck,
} from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { canAccessSite, siteScope, type Actor } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });
const WEEKLY_STATUSES = ["over", "near", "ok", "noData"] as const;

const checkOutput = z.object({
  status: z.enum(WEEKLY_STATUSES),
  maxWindow: z.object({ from: z.string(), to: z.string(), minutes: z.number() }).nullable(),
  overWindowStarts: z.array(z.string()),
  breakDaysOver: z.array(z.object({ date: z.string(), minutes: z.number() })),
});
const breakOutput = z.object({ id: z.string(), fromDate: z.string(), toDate: z.string(), note: z.string().nullable() });

/** 期間を指定しなければ、今日までの 4 週間 */
const periodOrDefault = (p: { from: string; to: string } | undefined, today: string) => p ?? { from: addDays(today, -27), to: today };

/** 28 時間の確認の対象(資格外活動の包括許可がある在籍者) */
async function weeklyTargets(tx: Tx, actor: Actor, today: string, siteId?: string) {
  return (await activePersonCards(tx, siteScope(actor), today, siteId)).filter(
    (p) => judgeWorkEligibility(p.card, classifyExpiry(p.card, today), today).weeklyHoursLimit === 28,
  );
}

/** 対象者ごとの判定(ダッシュボードの件数にも使う) */
export async function weeklyChecks(tx: Tx, actor: Actor, today: string, period: { from: string; to: string }, siteId?: string) {
  const targets = await weeklyTargets(tx, actor, today, siteId);
  const ids = targets.map((t) => t.id);
  // 期間の最初の日に終わる 7 日を見るため、6 日前から読む
  const days = await listWorkDays(tx, ids, addDays(period.from, -6), period.to);
  const breaks = await listStudyBreaks(tx, ids);
  return targets.map((t) => ({
    person: t,
    check: checkWeeklyHours(
      days.filter((d) => d.personId === t.id),
      breaks.filter((b) => b.personId === t.id),
      period,
    ) satisfies WeeklyCheck,
  }));
}

export const workHoursRouter = router({
  importDays: permissionProcedure("imports.run")
    .input(workImportInput)
    .output(
      z.object({
        /** 保存した(dryRun なら保存できる)人・日の数 */
        days: z.number(),
        persons: z.number(),
        /** 週28時間の確認の対象でない人の行の数(保存はする) */
        notTargetRows: z.number(),
        errors: z.array(z.object({ line: z.number(), errors: z.array(z.string()) })),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const people = new Map(
          (await findPersonsByEmployeeCodes(tx, [...new Set(input.rows.map((r) => r.employeeCode))])).map((p) => [p.employeeCode, p]),
        );
        const targets = new Set((await weeklyTargets(tx, ctx.actor, today)).map((t) => t.id));
        const errors: { line: number; errors: string[] }[] = [];
        const totals = new Map<string, { personId: string; workDate: string; minutes: number }>();
        let notTargetRows = 0;
        for (const r of input.rows) {
          const p = people.get(r.employeeCode);
          if (!p || !canAccessSite(ctx.actor, p.siteId)) {
            errors.push({ line: r.line, errors: [`社員番号「${r.employeeCode}」の登録者がいません`] });
            continue;
          }
          if (p.status === "archived") {
            errors.push({ line: r.line, errors: ["この社員番号の登録者はアーカイブ済みです"] });
            continue;
          }
          if (!targets.has(p.id)) notTargetRows++;
          const key = `${p.id}|${r.date}`;
          const cur = totals.get(key);
          if (cur) cur.minutes += r.minutes;
          else totals.set(key, { personId: p.id, workDate: r.date, minutes: r.minutes });
        }
        for (const t of totals.values()) {
          if (t.minutes > 1440) {
            const lines = input.rows.filter((r) => people.get(r.employeeCode)?.id === t.personId && r.date === t.workDate).map((r) => r.line);
            errors.push({ line: lines[0]!, errors: [`同じ日の合計が 24 時間を超えています(${lines.join("・")} 行目)`] });
            totals.delete(`${t.personId}|${t.workDate}`);
          }
        }
        const rows = [...totals.values()];
        const persons = new Set(rows.map((r) => r.personId)).size;
        if (!input.dryRun && rows.length > 0) await upsertWorkDays(tx, rows);
        // 試しの実行も、登録者との突き合わせなので記録する(値は残さない)
        await ctx.audit(tx, {
          action: input.dryRun ? "work_days.import_preview" : "work_days.import",
          detail: { rows: input.rows.length, days: rows.length, persons, errors: errors.length },
        });
        errors.sort((a, b) => a.line - b.line);
        return { days: rows.length, persons, notTargetRows, errors };
      }),
    ),

  list: permissionProcedure("persons.read")
    .input(z.object({ period: workPeriodInput.optional(), siteId: z.uuid().optional() }).default({}))
    .output(
      z.object({
        from: z.string(),
        to: z.string(),
        items: z.array(z.object({ id: z.string(), employeeCode: z.string(), name: z.string(), siteName: z.string(), check: checkOutput })),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const period = periodOrDefault(input.period, today);
        const order = { over: 0, near: 1, noData: 2, ok: 3 } as const;
        const items = (await weeklyChecks(tx, ctx.actor, today, period, input.siteId))
          .map(({ person: p, check }) => ({ id: p.id, employeeCode: p.employeeCode, name: p.name, siteName: p.siteName, check }))
          .sort((a, b) => order[a.check.status] - order[b.check.status] || (b.check.maxWindow?.minutes ?? 0) - (a.check.maxWindow?.minutes ?? 0) || a.employeeCode.localeCompare(b.employeeCode));
        return { ...period, items };
      }),
    ),

  person: permissionProcedure("persons.read")
    .input(z.object({ personId: z.uuid(), period: workPeriodInput.optional() }))
    .output(
      z.object({
        from: z.string(),
        to: z.string(),
        /** 週28時間の確認の対象か(資格外活動の包括許可) */
        target: z.boolean(),
        days: z.array(z.object({ date: z.string(), minutes: z.number() })),
        breaks: z.array(breakOutput),
        check: checkOutput,
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const p = await getPerson(tx, input.personId, siteScope(ctx.actor), today);
        if (!p) throw notFound();
        const period = periodOrDefault(input.period, today);
        const target = judgeWorkEligibility(p.card, classifyExpiry(p.card, today), today).weeklyHoursLimit === 28;
        const days = (await listWorkDays(tx, [p.id], addDays(period.from, -6), period.to)).map(({ date, minutes }) => ({ date, minutes }));
        const breaks = (await listStudyBreaks(tx, [p.id])).map(({ personId: _p, ...b }) => b);
        return { ...period, target, days, breaks, check: checkWeeklyHours(days, breaks, period) };
      }),
    ),

  addBreak: permissionProcedure("persons.write")
    .input(studyBreakInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const p = await getPerson(tx, input.personId, siteScope(ctx.actor), jstDate(ctx.services.now()));
        if (!p) throw notFound();
        const id = await insertStudyBreak(tx, { personId: p.id, fromDate: input.fromDate, toDate: input.toDate, note: input.note ?? null });
        await ctx.audit(tx, { action: "study_break.create", targetType: "person", targetId: p.id });
        return { id };
      }),
    ),

  removeBreak: permissionProcedure("persons.write")
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const b = await findStudyBreak(tx, input.id);
        if (!b || !(await getPerson(tx, b.personId, siteScope(ctx.actor), jstDate(ctx.services.now())))) throw notFound();
        await deleteStudyBreak(tx, input.id);
        await ctx.audit(tx, { action: "study_break.delete", targetType: "person", targetId: b.personId });
        return { ok: true as const };
      }),
    ),
});
