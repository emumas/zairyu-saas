/**
 * 登録者(1-6)。
 * - 拠点管理者・閲覧者は担当拠点の登録者だけを扱える(範囲外は NOT_FOUND)
 * - 閲覧者には生年月日・国籍・電話番号を返さない(期限と就労可否の閲覧のみ。DESIGN.md 5章)
 * - 変更はすべて監査ログに記録する(項目名のみ。値は残さない)
 */
import {
  backfillNationalityFromCards,
  createPerson,
  findSimilarPersons,
  insertEmployment,
  listDuplicateGroups,
  listEmployments,
  findPersonSite,
  getPerson,
  isActiveSite,
  listPersons,
  setPersonStatus,
  updatePerson,
  type Tx,
} from "@zairyu/db";
import {
  classifyExpiry,
  judgeWorkEligibility,
  WORK_LEVELS,
  EXPIRY_BUCKETS,
  jstDate,
  personCreateInput,
  personListInput,
  personUpdateInput,
  personMatchName,
  rehireInput,
  retireInput,
  RETIRE_REASONS,
  toKatakana,
  duplicateCheckInput,
  type RetireReason,
} from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { assertCanAddPersons } from "../billingGuard.js";
import { canAccessSite, siteScope, type Actor, type Role } from "../authz/permissions.js";
import { permissionProcedure, router } from "../trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

const cardSummary = z
  .object({
    id: z.string(),
    cardFormat: z.enum(["legacy", "gen2", "tokutei"]),
    statusOfResidence: z.string().nullable(),
    expiryDate: z.string().nullable(),
    cardValidUntil: z.string().nullable(),
    workRestriction: z.string().nullable(),
    outsideActivity: z.string().nullable(),
    pendingApplication: z.boolean(),
    icVerified: z.boolean(),
    needsReview: z.boolean(),
  })
  .nullable();

const personOutput = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  employeeCode: z.string(),
  name: z.string(),
  nameKana: z.string().nullable(),
  /** 閲覧者には null */
  phone: z.string().nullable(),
  /** 閲覧者には null */
  nationality: z.string().nullable(),
  /** 閲覧者には null */
  birthDate: z.string().nullable(),
  status: z.enum(["active", "retired", "archived"]),
  retiredAt: z.string().nullable(),
  /** 入社日(今の在籍期間) */
  hiredAt: z.string().nullable(),
  employmentInsured: z.boolean().nullable(),
  card: cardSummary,
  /** 就労可否(カードの記載による判定。雇用主の確認の補助) */
  work: z.object({
    level: z.enum(WORK_LEVELS),
    reasons: z.array(z.string()),
    checks: z.array(z.string()),
    weeklyHoursLimit: z.number().nullable(),
  }),
  /** 期限区分(1-11) */
  expiry: z.object({
    bucket: z.enum(EXPIRY_BUCKETS),
    deadline: z.string().nullable(),
    deadlineBasis: z.enum(["stay", "card"]).nullable(),
    daysLeft: z.number().nullable(),
    specialPeriodUntil: z.string().nullable(),
    icUnverified: z.boolean(),
    needsReview: z.boolean(),
  }),
});

type PersonRow = NonNullable<Awaited<ReturnType<typeof getPerson>>>;

const employmentOutput = z.object({
  hiredAt: z.string().nullable(),
  retiredAt: z.string(),
  reasonCode: z.enum(RETIRE_REASONS),
  reasonNote: z.string().nullable(),
  siteName: z.string().nullable(),
});

const similarOutput = z.object({
  /** 担当外の拠点の人は null(社員番号・拠点名・状態だけ) */
  id: z.string().nullable(),
  employeeCode: z.string(),
  name: z.string().nullable(),
  siteName: z.string(),
  status: z.enum(["active", "retired", "archived"]),
  retiredAt: z.string().nullable(),
  /** 前回の退職(担当外の拠点の人は null) */
  lastEmployment: employmentOutput.nullable(),
  /** 生年月日まで一致(氏名だけの一致は参考) */
  strong: z.boolean(),
});

async function similarPersons(tx: Tx, actor: Actor, q: { name: string; nameKana?: string | undefined; birthDate?: string | undefined; excludeId?: string | undefined }) {
  const rows = await findSimilarPersons(tx, { matchName: personMatchName(q.name), nameKana: q.nameKana ? toKatakana(q.nameKana) : null, birthDate: q.birthDate ?? null, excludeId: q.excludeId });
  const visibleIds = rows.filter((r) => canAccessSite(actor, r.siteId)).map((r) => r.id);
  const employments = await listEmployments(tx, visibleIds);
  return rows.map((r) => {
    const visible = canAccessSite(actor, r.siteId);
    const last = visible ? employments.find((e) => e.personId === r.id) : undefined;
    return {
      id: visible ? r.id : null,
      employeeCode: r.employeeCode,
      name: visible ? r.name : null,
      siteName: r.siteName,
      status: r.status,
      retiredAt: r.retiredAt,
      strong: !!q.birthDate && r.birthDate === q.birthDate,
      lastEmployment: last ? { hiredAt: last.hiredAt, retiredAt: last.retiredAt, reasonCode: last.reasonCode as RetireReason, reasonNote: last.reasonNote, siteName: last.siteName } : null,
    };
  });
}

function present(row: PersonRow, role: Role, today: string): z.infer<typeof personOutput> {
  const hidePersonal = role === "viewer";
  const expiry = classifyExpiry(row.card, today);
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.siteName,
    employeeCode: row.employeeCode,
    name: row.name,
    nameKana: row.nameKana,
    phone: hidePersonal ? null : row.phone,
    nationality: hidePersonal ? null : row.nationality,
    birthDate: hidePersonal ? null : row.birthDate,
    status: row.status,
    retiredAt: row.retiredAt,
    hiredAt: row.hiredAt,
    employmentInsured: hidePersonal ? null : row.employmentInsured,
    card: row.card,
    expiry,
    work: judgeWorkEligibility(row.card, expiry, today),
  };
}

/** 対象の登録者が見える範囲にいることを確かめ、現在の拠点と状態を返す */
async function loadForWrite(tx: Tx, actor: Actor, id: string) {
  const p = await findPersonSite(tx, id);
  if (!p) throw notFound();
  assertSiteAccess(actor, p.siteId);
  return p;
}

async function assertUsableSite(tx: Tx, actor: Actor, siteId: string) {
  assertSiteAccess(actor, siteId);
  if (!(await isActiveSite(tx, siteId))) throw new TRPCError({ code: "BAD_REQUEST", message: "拠点が見つかりません" });
}

/** 社員番号の重複(一意制約違反)を利用者向けのエラーにする */
async function withDuplicateCheck<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string; constraint?: string } };
    if ((err.code ?? err.cause?.code) === "23505") {
      throw new TRPCError({ code: "CONFLICT", message: "同じ社員番号の登録者がすでにいます" });
    }
    throw e;
  }
}

export const personsRouter = router({
  list: permissionProcedure("persons.read")
    .input(personListInput)
    .output(z.object({ items: z.array(personOutput), total: z.number() }))
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const { workLevels, ...q } = input;
        if (workLevels) {
          // 就労可否はアプリ側で判定するので、条件に合う在籍者をまとめて取って絞り込み、ここでページ分けする
          const all = await listPersons(tx, { ...q, statuses: q.statuses ?? ["active"], limit: 100_000, offset: 0, scope: siteScope(ctx.actor), today });
          const hit = all.items.map((p) => present(p, ctx.actor.role, today)).filter((p) => workLevels.includes(p.work.level));
          return { items: hit.slice(input.offset, input.offset + input.limit), total: hit.length };
        }
        const r = await listPersons(tx, { ...q, scope: siteScope(ctx.actor), today });
        return { items: r.items.map((p) => present(p, ctx.actor.role, today)), total: r.total };
      }),
    ),

  get: permissionProcedure("persons.read")
    .input(z.object({ id: z.uuid() }))
    .output(personOutput.extend({ employments: z.array(employmentOutput) }))
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        let p = await getPerson(tx, input.id, siteScope(ctx.actor), today);
        if (!p) throw notFound();
        // 国籍が空欄で、今のカードの国籍・地域が国コードに直せるなら入れる(以前に登録した人も、開いたときに埋まる)
        if (!p.nationality && ctx.actor.role !== "viewer" && (await backfillNationalityFromCards(tx, [p.id])).length > 0) {
          await ctx.audit(tx, { action: "person.update", targetType: "person", targetId: p.id, detail: { via: "card_nationality", fields: ["nationality"] } });
          p = (await getPerson(tx, input.id, siteScope(ctx.actor), today))!;
        }
        // 退職理由は個人の事情を含みうるので、閲覧者には見せない
        const employments = ctx.actor.role === "viewer" ? [] : await listEmployments(tx, [p.id]);
        return { ...present(p, ctx.actor.role, today), employments: employments.map(({ personId: _p, ...e }) => ({ ...e, reasonCode: e.reasonCode as RetireReason })) };
      }),
    ),

  /**
   * 同一人物と思われる登録者を探す(登録前の確認用)。
   * - 在籍中の人がいれば二重登録の疑い(別の拠点なら異動として既存の登録者を使う)
   * - 退職した人がいれば再入社として、前回の退職理由を出す
   * 担当外の拠点の人は、社員番号と拠点名・状態だけを返す
   */
  findSimilar: permissionProcedure("persons.write")
    .input(duplicateCheckInput)
    .output(z.array(similarOutput))
    .query(({ ctx, input }) => ctx.tenantTx((tx) => similarPersons(tx, ctx.actor, input))),

  /** 二重登録の疑い(在籍中で、氏名と生年月日、またはフリガナと生年月日が同じ人の組) */
  duplicates: permissionProcedure("persons.write")
    .output(
      z.array(
        z.object({
          members: z.array(
            z.object({
              id: z.string().nullable(),
              employeeCode: z.string(),
              name: z.string().nullable(),
              siteName: z.string(),
              birthDate: z.string().nullable(),
              hiredAt: z.string().nullable(),
            }),
          ),
        }),
      ),
    )
    .query(({ ctx }) =>
      ctx.tenantTx(async (tx) =>
        (await listDuplicateGroups(tx, siteScope(ctx.actor))).map((g) => ({
          members: g.members.map((m) => {
            const visible = canAccessSite(ctx.actor, m.siteId);
            return {
              id: visible ? m.id : null,
              employeeCode: m.employeeCode,
              name: visible ? m.name : null,
              siteName: m.siteName,
              birthDate: visible ? m.birthDate : null,
              hiredAt: visible ? m.hiredAt : null,
            };
          }),
        })),
      ),
    ),

  create: permissionProcedure("persons.write")
    .input(personCreateInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await assertCanAddPersons(tx, ctx.services.now());
        await assertUsableSite(tx, ctx.actor, input.siteId);
        const { confirmDuplicate, ...values } = input;
        if (!confirmDuplicate) {
          const similar = await similarPersons(tx, ctx.actor, { name: input.name, nameKana: input.nameKana ?? undefined, birthDate: input.birthDate ?? undefined });
          // 生年月日まで一致した人だけで止める(氏名だけの一致は画面で参考に出す)
          const active = similar.filter((p) => p.strong && p.status === "active");
          const retired = similar.filter((p) => p.strong && p.status === "retired");
          if (active.length > 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `同一人物と思われる在籍者がいます(${active.map((p) => `${p.siteName} ${p.employeeCode}`).join("、")})。異動の場合は既存の登録者の拠点を変更してください。別人であることを確かめたうえで登録する場合は、確認のうえ登録してください`,
            });
          }
          if (retired.length > 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `以前在籍していた方と思われる登録者がいます(${retired.map((p) => `${p.siteName} ${p.employeeCode}`).join("、")})。再入社の場合は、その登録者を再入社にしてください`,
            });
          }
        }
        const id = await withDuplicateCheck(createPerson(tx, values));
        await ctx.audit(tx, { action: "person.create", targetType: "person", targetId: id });
        return { id };
      }),
    ),

  update: permissionProcedure("persons.write")
    .input(personUpdateInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const { id, ...patch } = input;
        const current = await loadForWrite(tx, ctx.actor, id);
        if (current.status === "archived") throw new TRPCError({ code: "BAD_REQUEST", message: "アーカイブ済みの登録者は変更できません" });
        // 拠点を移す場合は移動先も担当範囲であること
        if (patch.siteId && patch.siteId !== current.siteId) await assertUsableSite(tx, ctx.actor, patch.siteId);
        const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(changes).length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "変更する項目がありません" });
        await withDuplicateCheck(updatePerson(tx, id, changes));
        await ctx.audit(tx, { action: "person.update", targetType: "person", targetId: id, detail: { fields: Object.keys(changes).sort() } });
        return { id };
      }),
    ),

  /** 退職。課金対象から外れるのは翌日から(DESIGN.md 6章) */
  retire: permissionProcedure("persons.write")
    .input(retireInput)
    .output(z.object({ id: z.string(), retiredAt: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const current = await loadForWrite(tx, ctx.actor, input.id);
        if (current.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "在籍中の登録者だけ退職にできます" });
        const retiredAt = input.retiredAt ?? jstDate(ctx.services.now());
        const p = await getPerson(tx, input.id, null, retiredAt);
        if (p?.hiredAt && retiredAt < p.hiredAt) throw new TRPCError({ code: "BAD_REQUEST", message: "退職日は入社日より後にしてください" });
        await setPersonStatus(tx, input.id, "retired", { retiredAt });
        // 在籍期間と退職理由を履歴に残す(再入社のときに確認する)
        await insertEmployment(tx, {
          personId: input.id,
          hiredAt: p?.hiredAt ?? null,
          retiredAt,
          reasonCode: input.reasonCode,
          reasonNote: input.reasonNote || null,
          siteId: current.siteId,
          recordedBy: ctx.actor.userId,
        });
        // 理由のメモは監査ログに残さない(区分だけ)
        await ctx.audit(tx, { action: "person.retire", targetType: "person", targetId: input.id, detail: { reasonCode: input.reasonCode } });
        return { id: input.id, retiredAt };
      }),
    ),

  /** 再入社(退職した登録者を在籍に戻す)。入社日を新しくし、前回の在籍期間は履歴に残る */
  reactivate: permissionProcedure("persons.write")
    .input(rehireInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const current = await loadForWrite(tx, ctx.actor, input.id);
        if (current.status !== "retired") throw new TRPCError({ code: "BAD_REQUEST", message: "退職した登録者だけ再入社にできます" });
        // 復職は課金対象の人数を増やすので、新規登録と同じく未払い時は止める
        await assertCanAddPersons(tx, ctx.services.now());
        await setPersonStatus(tx, input.id, "active", { retiredAt: null });
        await updatePerson(tx, input.id, { hiredAt: input.hiredAt ?? jstDate(ctx.services.now()) });
        await ctx.audit(tx, { action: "person.reactivate", targetType: "person", targetId: input.id });
        return { id: input.id };
      }),
    ),

  /** アーカイブ(一覧の既定表示から外す。保存期間が過ぎたら自動削除の対象: 1-21) */
  archive: permissionProcedure("persons.write")
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const current = await loadForWrite(tx, ctx.actor, input.id);
        if (current.status === "archived") throw new TRPCError({ code: "BAD_REQUEST", message: "すでにアーカイブ済みです" });
        await setPersonStatus(tx, input.id, "archived", {
          archivedAt: new Date(ctx.services.now()),
          // 在籍中のままアーカイブした場合も退職日を残す(保存期間の起算に使う)
          ...(current.status === "active" ? { retiredAt: jstDate(ctx.services.now()) } : {}),
        });
        await ctx.audit(tx, { action: "person.archive", targetType: "person", targetId: input.id });
        return { id: input.id };
      }),
    ),
});
