/**
 * 職種照合(テスト運用)。テナントの設定で有効にしたときだけ使える。
 * 自社の職種を登録し、登録者に割り当てて在留資格との照合の目安を出す。確認したことは追加だけの記録に残す。
 * 最終的な判断は雇用主が行う(画面に明記)
 */
import {
  getJobCategory,
  getPerson,
  insertJobCategory,
  insertJobCheck,
  jobMatchingEnabled,
  lastJobCheck,
  listJobCategories,
  listJobChecks,
  personJob,
  schema,
  setPersonJob,
  updateJobCategory,
  type Tx,
} from "@zairyu/db";
import { jobCategoryInput, jobCheckInput, jstDate, judgeJobMatch, SSW_FIELD_KEYS } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { siteScope } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

async function requireEnabled(tx: Tx) {
  if (!(await jobMatchingEnabled(tx))) throw new TRPCError({ code: "BAD_REQUEST", message: "職種照合(テスト運用)は有効になっていません(設定で有効にできます)" });
}

const categoryOutput = z.object({
  id: z.string(),
  name: z.string(),
  simpleWork: z.boolean(),
  adultEntertainment: z.boolean(),
  sswField: z.string().nullable(),
  note: z.string().nullable(),
  archivedAt: z.date().nullable(),
});

export const jobsRouter = router({
  /** 有効かどうか(画面の出し分け用) */
  enabled: permissionProcedure("persons.read")
    .output(z.object({ enabled: z.boolean() }))
    .query(({ ctx }) => ctx.tenantTx(async (tx) => ({ enabled: await jobMatchingEnabled(tx) }))),

  setEnabled: permissionProcedure("tenant.settings")
    .input(z.object({ enabled: z.boolean() }))
    .output(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await tx.update(schema.tenants).set({ jobMatchingEnabled: input.enabled }).where(eq(schema.tenants.id, ctx.actor.tenantId));
        await ctx.audit(tx, { action: "tenant.job_matching", targetType: "tenant", targetId: ctx.actor.tenantId, detail: { enabled: input.enabled } });
        return { enabled: input.enabled };
      }),
    ),

  categories: router({
    list: permissionProcedure("persons.read")
      .output(z.array(categoryOutput))
      .query(({ ctx }) =>
        ctx.tenantTx(async (tx) => {
          await requireEnabled(tx);
          return (await listJobCategories(tx)).map(({ tenantId: _t, createdAt: _c, ...c }) => c);
        }),
      ),
    create: permissionProcedure("tenant.settings")
      .input(jobCategoryInput)
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          await requireEnabled(tx);
          const id = await insertJobCategory(tx, { ...input, note: input.note ?? null });
          await ctx.audit(tx, { action: "job_category.create", targetType: "job_category", targetId: id });
          return { id };
        }),
      ),
    update: permissionProcedure("tenant.settings")
      .input(jobCategoryInput.partial().extend({ id: z.uuid(), archived: z.boolean().optional() }))
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          await requireEnabled(tx);
          const { id, archived, ...rest } = input;
          const patch = {
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
            ...(archived !== undefined ? { archivedAt: archived ? new Date(ctx.services.now()) : null } : {}),
          };
          if (!(await updateJobCategory(tx, id, patch))) throw notFound();
          await ctx.audit(tx, { action: "job_category.update", targetType: "job_category", targetId: id, detail: { fields: Object.keys(patch).sort() } });
          return { id };
        }),
      ),
  }),

  /** 登録者の職種と照合の結果・確認の記録 */
  person: permissionProcedure("persons.read")
    .input(z.object({ personId: z.uuid() }))
    .output(
      z.object({
        jobCategoryId: z.string().nullable(),
        jobName: z.string().nullable(),
        sswField: z.string().nullable(),
        match: z.object({ level: z.enum(["ok", "check", "ng", "none"]), reasons: z.array(z.string()), checks: z.array(z.string()) }),
        history: z.array(
          z.object({
            id: z.string(),
            jobName: z.string(),
            statusOfResidence: z.string().nullable(),
            result: z.string(),
            items: z.array(z.string()),
            note: z.string().nullable(),
            checkedByEmail: z.string().nullable(),
            checkedAt: z.date(),
          }),
        ),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await requireEnabled(tx);
        const today = jstDate(ctx.services.now());
        const p = await getPerson(tx, input.personId, siteScope(ctx.actor), today);
        if (!p) throw notFound();
        const pj = (await personJob(tx, p.id))!;
        const job = pj.jobCategoryId ? await getJobCategory(tx, pj.jobCategoryId) : null;
        const last = job ? await lastJobCheck(tx, p.id, job.id, p.card?.statusOfResidence ?? null) : null;
        const match = judgeJobMatch(
          {
            card: p.card?.id ? { cardKind: p.card.cardKind, statusOfResidence: p.card.statusOfResidence, workRestriction: p.card.workRestriction, outsideActivity: p.card.outsideActivity, outsideActivityUntil: p.card.outsideActivityUntil } : null,
            personSswField: pj.sswField,
            job,
            lastCheck: last,
          },
          today,
        );
        // 確認の記録はメモに個人の事情を含みうるので、閲覧者には見せない
        const history = ctx.actor.role === "viewer" ? [] : (await listJobChecks(tx, p.id)).map((h) => ({ ...h, items: (h.items as string[]) ?? [] }));
        return { jobCategoryId: job?.id ?? null, jobName: job?.name ?? null, sswField: pj.sswField, match, history };
      }),
    ),

  /** 職種・指定書の分野を割り当てる */
  assign: permissionProcedure("persons.write")
    .input(z.object({ personId: z.uuid(), jobCategoryId: z.uuid().nullable().optional(), sswField: z.enum(SSW_FIELD_KEYS).nullable().optional() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await requireEnabled(tx);
        const p = await getPerson(tx, input.personId, siteScope(ctx.actor), jstDate(ctx.services.now()));
        if (!p) throw notFound();
        if (input.jobCategoryId) {
          const job = await getJobCategory(tx, input.jobCategoryId);
          if (!job || job.archivedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "その職種は使えません" });
        }
        await setPersonJob(tx, p.id, {
          ...(input.jobCategoryId !== undefined ? { jobCategoryId: input.jobCategoryId } : {}),
          ...(input.sswField !== undefined ? { sswField: input.sswField } : {}),
        });
        await ctx.audit(tx, { action: "person.job_assign", targetType: "person", targetId: p.id, detail: { jobCategoryId: input.jobCategoryId ?? null, sswField: input.sswField ?? null } });
        return { ok: true as const };
      }),
    ),

  /** 確認の記録(追加だけ) */
  check: permissionProcedure("persons.write")
    .input(jobCheckInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await requireEnabled(tx);
        const p = await getPerson(tx, input.personId, siteScope(ctx.actor), jstDate(ctx.services.now()));
        if (!p) throw notFound();
        const pj = (await personJob(tx, p.id))!;
        if (!pj.jobCategoryId) throw new TRPCError({ code: "BAD_REQUEST", message: "先に職種を割り当ててください" });
        const id = await insertJobCheck(tx, {
          personId: p.id,
          jobCategoryId: pj.jobCategoryId,
          statusOfResidence: p.card?.statusOfResidence ?? null,
          result: input.result,
          items: input.items,
          note: input.note ?? null,
          checkedBy: ctx.actor.userId,
        });
        await ctx.audit(tx, { action: "person.job_check", targetType: "person", targetId: p.id, detail: { result: input.result, items: input.items.length } });
        return { id };
      }),
    ),
});
