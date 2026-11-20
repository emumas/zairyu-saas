/**
 * 登録者(1-6)。
 * - 拠点管理者・閲覧者は担当拠点の登録者だけを扱える(範囲外は NOT_FOUND)
 * - 閲覧者には生年月日・国籍を返さない(期限と就労可否の閲覧のみ。DESIGN.md 5章)
 * - 変更はすべて監査ログに記録する(項目名のみ。値は残さない)
 */
import {
  createPerson,
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
  dateString,
  EXPIRY_BUCKETS,
  jstDate,
  personCreateInput,
  personListInput,
  personUpdateInput,
} from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { siteScope, type Actor, type Role } from "../authz/permissions.js";
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
  /** 閲覧者には null */
  nationality: z.string().nullable(),
  /** 閲覧者には null */
  birthDate: z.string().nullable(),
  status: z.enum(["active", "retired", "archived"]),
  retiredAt: z.string().nullable(),
  card: cardSummary,
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

function present(row: PersonRow, role: Role, today: string): z.infer<typeof personOutput> {
  const hidePersonal = role === "viewer";
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.siteName,
    employeeCode: row.employeeCode,
    name: row.name,
    nationality: hidePersonal ? null : row.nationality,
    birthDate: hidePersonal ? null : row.birthDate,
    status: row.status,
    retiredAt: row.retiredAt,
    card: row.card,
    expiry: classifyExpiry(row.card, today),
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
        const r = await listPersons(tx, { ...input, scope: siteScope(ctx.actor), today });
        return { items: r.items.map((p) => present(p, ctx.actor.role, today)), total: r.total };
      }),
    ),

  get: permissionProcedure("persons.read")
    .input(z.object({ id: z.uuid() }))
    .output(personOutput)
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const today = jstDate(ctx.services.now());
        const p = await getPerson(tx, input.id, siteScope(ctx.actor), today);
        if (!p) throw notFound();
        return present(p, ctx.actor.role, today);
      }),
    ),

  create: permissionProcedure("persons.write")
    .input(personCreateInput)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        // TODO(1-18): 未払いの猶予期間を過ぎたテナントは新規登録を止める
        await assertUsableSite(tx, ctx.actor, input.siteId);
        const id = await withDuplicateCheck(createPerson(tx, input));
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
    .input(z.object({ id: z.uuid(), retiredAt: dateString.optional() }))
    .output(z.object({ id: z.string(), retiredAt: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const current = await loadForWrite(tx, ctx.actor, input.id);
        if (current.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "在籍中の登録者だけ退職にできます" });
        const retiredAt = input.retiredAt ?? jstDate(ctx.services.now());
        await setPersonStatus(tx, input.id, "retired", { retiredAt });
        await ctx.audit(tx, { action: "person.retire", targetType: "person", targetId: input.id });
        return { id: input.id, retiredAt };
      }),
    ),

  /** 退職の取り消し(復職) */
  reactivate: permissionProcedure("persons.write")
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const current = await loadForWrite(tx, ctx.actor, input.id);
        if (current.status !== "retired") throw new TRPCError({ code: "BAD_REQUEST", message: "退職した登録者だけ復職にできます" });
        await setPersonStatus(tx, input.id, "active", { retiredAt: null });
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
