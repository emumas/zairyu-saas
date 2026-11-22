/**
 * 運営者コンソール(1-19): テナント・プラン・個別単価。
 * - 運営者は登録者の個人情報を見ない(テナントは契約と人数だけ)
 * - 操作はすべて platform_audit_logs に記録する(追記専用)。テナントに関わる操作はテナントの監査ログにも残す
 * - ログインは Web 管理画面からだけ(セッションは HttpOnly Cookie)
 */
import {
  getTenantForPlatform,
  insertAudit,
  insertInvitedUser,
  insertPlan,
  insertTenant,
  EXPORT_LIMIT,
  listPlansForPlatform,
  listPlatformAuditLogs,
  listPlatformOperators,
  listTenantsForPlatform,
  lookupUserForLogin,
  planExists,
  schema,
  updatePlan,
  updateTenantByPlatform,
  upsertPriceOverride,
  withTenant,
  type Tx,
} from "@zairyu/db";
import { addDays, daysBetween, dateString, planInput, priceOverrideInput, pricingTiersSchema, resolvePricing, siteNameInput, TENANT_STATUSES } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../auth/password.js";
import { PLATFORM_SESSION_TTL_SEC } from "../auth/platformAuth.js";
import { issueInvitation } from "../invitations.js";
import { PLATFORM_SESSION_COOKIE, platformAuthOf, platformProcedure, publicProcedure, requireServices, router, type Context, type Services } from "../trpc.js";

const COOKIE_PATH = "/trpc";
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

function limit(ctx: Context) {
  if (!requireServices(ctx).authRateLimiter.take(ctx.ip ?? "unknown")) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "しばらく時間をおいてから再度お試しください" });
  }
}

/** 運営者のログインは Web 管理画面からだけ受け付ける(Cookie と独自ヘッダーが前提) */
function requireWeb(ctx: Context) {
  if (!ctx.web) throw new TRPCError({ code: "BAD_REQUEST", message: "運営者コンソールから操作してください" });
  return ctx.web;
}

async function assertPlan(tx: Tx, planId: string | null | undefined) {
  if (planId && !(await planExists(tx, planId))) throw new TRPCError({ code: "BAD_REQUEST", message: "プランが見つかりません" });
}

/** 新しいテナント管理者を招待する(テナントの監査ログにも残す) */
async function inviteTenantAdmin(services: Services, tenantId: string, email: string, operatorId: string, ip: string | null) {
  return withTenant(services.db, tenantId, async (tx) => {
    const [existing] = await tx.select().from(schema.users).where(and(eq(schema.users.email, email)));
    let userId: string;
    if (existing) {
      if (existing.status !== "invited" || existing.role !== "tenant_admin") {
        throw new TRPCError({ code: "CONFLICT", message: "このメールアドレスは既にこのテナントで使われています" });
      }
      userId = existing.id;
    } else {
      if (await lookupUserForLogin(services.db, email)) throw new TRPCError({ code: "CONFLICT", message: "このメールアドレスは既に使われています" });
      userId = await insertInvitedUser(tx, { email, role: "tenant_admin" });
    }
    const inv = await issueInvitation(services, tx, { tenantId, userId, email, createdBy: null });
    await insertAudit(tx, { actorId: null, action: "user.invite", targetType: "user", targetId: userId, detail: { role: "tenant_admin", by: "platform", operatorId }, ip });
    return { userId, ...inv };
  });
}

const PAGE = 100;
const auditQueryInput = z.object({
  period: z
    .object({ from: dateString, to: dateString })
    .refine((p) => p.from <= p.to, { message: "開始日は終了日以前にしてください" })
    .refine((p) => daysBetween(p.from, p.to) < 366, { message: "期間は 1 年以内にしてください" }),
  operatorId: z.uuid().optional(),
  tenantId: z.uuid().optional(),
  action: z.string().trim().max(64).optional(),
});
const auditQuery = (q: z.infer<typeof auditQueryInput>) => ({
  from: new Date(`${q.period.from}T00:00:00+09:00`),
  to: new Date(`${addDays(q.period.to, 1)}T00:00:00+09:00`),
  operatorId: q.operatorId,
  tenantId: q.tenantId,
  action: q.action || undefined,
});
const auditRowOutput = z.object({
  id: z.number(),
  at: z.date(),
  operatorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  targetName: z.string().nullable(),
  detail: z.unknown(),
  ip: z.string().nullable(),
});

const tierOutput = z.array(z.object({ upTo: z.number().nullable(), unitPrice: z.number() }));
const planOutput = z.object({
  id: z.string(),
  name: z.string(),
  baseFee: z.number(),
  billingMode: z.enum(["per_unit", "tiered"]),
  unitPrice: z.number().nullable(),
  tiers: tierOutput.nullable(),
  tenantCount: z.number(),
});
const email = z.email("メールアドレスの形式が正しくありません").trim().toLowerCase().max(254);

export const platformRouter = router({
  auth: router({
    login: publicProcedure
      .input(z.object({ email: z.string().max(254), password: z.string().max(PASSWORD_MAX_LENGTH) }))
      .output(z.object({ challengeToken: z.string() }))
      .mutation(({ ctx, input }) => {
        limit(ctx);
        requireWeb(ctx);
        return platformAuthOf(requireServices(ctx)).login(input.email, input.password, ctx.ip);
      }),

    verifyTotp: publicProcedure
      .input(z.object({ challengeToken: z.string().max(2000), code: z.string().regex(/^\d{6}$/, "6 桁の数字を入力してください") }))
      .output(z.object({ email: z.string() }))
      .mutation(async ({ ctx, input }) => {
        limit(ctx);
        const web = requireWeb(ctx);
        const r = await platformAuthOf(requireServices(ctx)).verifyTotp(input.challengeToken, input.code, ctx.ip);
        web.setCookie(PLATFORM_SESSION_COOKIE, r.sessionToken, { maxAgeSec: PLATFORM_SESSION_TTL_SEC, path: COOKIE_PATH });
        return { email: r.operator.email };
      }),

    me: platformProcedure.output(z.object({ email: z.string() })).query(({ ctx }) => ({ email: ctx.operator.email })),

    logout: publicProcedure.output(z.object({ ok: z.boolean() })).mutation(({ ctx }) => {
      requireWeb(ctx).setCookie(PLATFORM_SESSION_COOKIE, "", { maxAgeSec: 0, path: COOKIE_PATH });
      return { ok: true };
    }),
  }),

  tenants: router({
    list: platformProcedure
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.enum(TENANT_STATUSES),
            planId: z.string().nullable(),
            planName: z.string().nullable(),
            hasOverride: z.boolean(),
            latestCountDate: z.string().nullable(),
            latestCount: z.number().nullable(),
            createdAt: z.date(),
          }),
        ),
      )
      .query(({ ctx }) => ctx.platformTx((tx) => listTenantsForPlatform(tx))),

    get: platformProcedure
      .input(z.object({ id: z.uuid() }))
      .output(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(TENANT_STATUSES),
          planId: z.string().nullable(),
          retentionYears: z.number(),
          pastDueSince: z.date().nullable(),
          createdAt: z.date(),
          override: z.object({ planId: z.string().nullable(), baseFee: z.number().nullable(), unitPrice: z.number().nullable(), tiers: tierOutput.nullable() }).nullable(),
          periods: z.array(z.object({ period: z.string(), peakCount: z.number(), amount: z.number(), status: z.string() })),
          daily: z.array(z.object({ date: z.string(), activeCount: z.number() })),
        }),
      )
      .query(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const r = await getTenantForPlatform(tx, input.id);
          if (!r) throw notFound();
          const { tenant: t, override: o } = r;
          const hasOverride = o && (o.baseFee !== null || o.unitPrice !== null || o.tiersJson !== null);
          return {
            id: t.id,
            name: t.name,
            status: t.status,
            planId: t.planId,
            retentionYears: t.retentionYears,
            pastDueSince: t.pastDueSince,
            createdAt: t.createdAt,
            override: hasOverride ? { planId: o.planId, baseFee: o.baseFee, unitPrice: o.unitPrice, tiers: o.tiersJson === null ? null : pricingTiersSchema.parse(o.tiersJson) } : null,
            periods: r.periods,
            daily: r.daily,
          };
        }),
      ),

    /** テナントを開設し、最初の拠点を作り、テナント管理者を招待する */
    create: platformProcedure
      .input(z.object({ name: z.string().trim().min(1, "テナント名を入力してください").max(200), adminEmail: email, siteName: siteNameInput, planId: z.uuid().nullable(), status: z.enum(["trial", "active"]) }))
      .output(z.object({ tenantId: z.string(), inviteUrl: z.string(), expiresAt: z.date() }))
      .mutation(async ({ ctx, input }) => {
        // 招待できないメールアドレスでテナントだけ残らないよう、先に確かめる
        if (await lookupUserForLogin(ctx.services.db, input.adminEmail)) throw new TRPCError({ code: "CONFLICT", message: "このメールアドレスは既に使われています" });
        const tenantId = await ctx.platformTx(async (tx) => {
          await assertPlan(tx, input.planId);
          const id = await insertTenant(tx, { name: input.name, status: input.status, planId: input.planId });
          await ctx.platformAudit(tx, { action: "tenant.create", targetType: "tenant", targetId: id, detail: { status: input.status, planId: input.planId } });
          return id;
        });
        await withTenant(ctx.services.db, tenantId, (tx) => tx.insert(schema.sites).values({ name: input.siteName }));
        const inv = await inviteTenantAdmin(ctx.services, tenantId, input.adminEmail, ctx.operator.id, ctx.ip);
        return { tenantId, inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt };
      }),

    update: platformProcedure
      .input(
        z.object({
          id: z.uuid(),
          name: z.string().trim().min(1).max(200).optional(),
          status: z.enum(TENANT_STATUSES).optional(),
          planId: z.uuid().nullable().optional(),
          retentionYears: z.number().int().min(3).max(5).optional(),
        }),
      )
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const { id } = input;
          const [current] = await tx.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, id));
          if (!current) throw notFound();
          const changes: Parameters<typeof updateTenantByPlatform>[2] = {};
          if (input.name !== undefined) changes.name = input.name;
          if (input.status !== undefined && input.status !== current.status) {
            changes.status = input.status;
            // 未払いの起点(1-18 の猶予期間)。未払い以外に戻したら消す
            changes.pastDueSince = input.status === "past_due" ? new Date(ctx.services.now()) : null;
          }
          if (input.planId !== undefined) changes.planId = input.planId;
          if (input.retentionYears !== undefined) changes.retentionYears = input.retentionYears;
          if (Object.keys(changes).length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "変更する項目がありません" });
          await assertPlan(tx, changes.planId);
          if (!(await updateTenantByPlatform(tx, id, changes))) throw notFound();
          await ctx.platformAudit(tx, { action: "tenant.update", targetType: "tenant", targetId: id, detail: { fields: Object.keys(changes).filter((k) => k !== "pastDueSince").sort(), ...(changes.status ? { status: changes.status } : {}) } });
          return { id };
        }),
      ),

    /** テナント管理者の招待(最初の管理者が受け取れなかったときの再発行や、追加) */
    inviteAdmin: platformProcedure
      .input(z.object({ tenantId: z.uuid(), email }))
      .output(z.object({ inviteUrl: z.string(), expiresAt: z.date() }))
      .mutation(async ({ ctx, input }) => {
        const inv = await inviteTenantAdmin(ctx.services, input.tenantId, input.email, ctx.operator.id, ctx.ip);
        await ctx.platformTx((tx) => ctx.platformAudit(tx, { action: "tenant.invite_admin", targetType: "tenant", targetId: input.tenantId, detail: { userId: inv.userId } }));
        return { inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt };
      }),

    /**
     * テナント管理者の認証アプリをリセットする(唯一のテナント管理者がスマホをなくした場合)。
     * 運営者は電話などで本人確認をしてから行う。テナントの監査ログにも残す
     */
    resetAdminTotp: platformProcedure
      .input(z.object({ tenantId: z.uuid(), email }))
      .output(z.object({ ok: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await withTenant(ctx.services.db, input.tenantId, async (tx) => {
          const [u] = await tx.select().from(schema.users).where(eq(schema.users.email, input.email));
          if (!u || u.role !== "tenant_admin") throw new TRPCError({ code: "NOT_FOUND", message: "このテナントのテナント管理者に、そのメールアドレスの人はいません" });
          await ctx.services.auth.resetTotp(tx, u.id);
          await insertAudit(tx, { actorId: null, action: "user.totp_reset", targetType: "user", targetId: u.id, detail: { by: "platform", operatorId: ctx.operator.id }, ip: ctx.ip });
        });
        await ctx.platformTx((tx) => ctx.platformAudit(tx, { action: "tenant.reset_admin_totp", targetType: "tenant", targetId: input.tenantId }));
        return { ok: true };
      }),

    /** 個別単価。null の項目はプランの値。clear で上書きをやめる */
    setPriceOverride: platformProcedure
      .input(z.object({ tenantId: z.uuid(), override: priceOverrideInput.nullable() }))
      .output(z.object({ ok: z.boolean() }))
      .mutation(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const r = await getTenantForPlatform(tx, input.tenantId);
          if (!r) throw notFound();
          const o = input.override;
          await assertPlan(tx, o?.planId);
          await upsertPriceOverride(tx, input.tenantId, o ? { planId: o.planId, baseFee: o.baseFee, unitPrice: o.unitPrice, tiersJson: o.tiers } : { planId: null, baseFee: null, unitPrice: null, tiersJson: null });
          await ctx.platformAudit(tx, { action: o ? "price_override.set" : "price_override.clear", targetType: "tenant", targetId: input.tenantId });
          return { ok: true };
        }),
      ),
  }),

  plans: router({
    list: platformProcedure.output(z.array(planOutput)).query(({ ctx }) =>
      ctx.platformTx(async (tx) =>
        (await listPlansForPlatform(tx)).map((p) => ({
          id: p.id,
          name: p.name,
          baseFee: p.baseFee,
          billingMode: p.billingMode,
          unitPrice: p.unitPrice,
          tiers: p.tiersJson === null ? null : pricingTiersSchema.parse(p.tiersJson),
          tenantCount: p.tenantCount,
        })),
      ),
    ),

    create: platformProcedure
      .input(planInput)
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const values = planValues(input);
          const id = await insertPlan(tx, values);
          await ctx.platformAudit(tx, { action: "plan.create", targetType: "plan", targetId: id, detail: { ...values, tiersJson: undefined, tiers: values.tiersJson } });
          return { id };
        }),
      ),

    /** プランの変更は、そのプランの全テナントの次の計算から効く(確定済みの月は変わらない) */
    update: platformProcedure
      .input(z.object({ id: z.uuid(), plan: planInput }))
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const values = planValues(input.plan);
          if (!(await updatePlan(tx, input.id, values))) throw notFound();
          await ctx.platformAudit(tx, { action: "plan.update", targetType: "plan", targetId: input.id, detail: { ...values, tiersJson: undefined, tiers: values.tiersJson } });
          return { id: input.id };
        }),
      ),
  }),

  /** 運営者の操作記録(platform_audit_logs)の閲覧と出力。期間は JST の日付 */
  auditLogs: router({
    operators: platformProcedure
      .output(z.array(z.object({ id: z.string(), email: z.string(), disabled: z.boolean() })))
      .query(({ ctx }) => ctx.platformTx(async (tx) => (await listPlatformOperators(tx)).map((o) => ({ id: o.id, email: o.email, disabled: o.disabledAt !== null })))),

    list: platformProcedure
      .input(auditQueryInput.extend({ beforeId: z.number().int().positive().optional() }))
      .output(z.object({ rows: z.array(auditRowOutput), nextBeforeId: z.number().nullable() }))
      .query(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const rows = await listPlatformAuditLogs(tx, { ...auditQuery(input), beforeId: input.beforeId, limit: PAGE + 1 });
          const page = rows.slice(0, PAGE);
          return { rows: page, nextBeforeId: rows.length > PAGE ? page.at(-1)!.id : null };
        }),
      ),

    /** CSV 用に条件に合うものをすべて返す(出力したことを記録する) */
    export: platformProcedure
      .input(auditQueryInput)
      .output(z.object({ rows: z.array(auditRowOutput) }))
      .mutation(({ ctx, input }) =>
        ctx.platformTx(async (tx) => {
          const rows = await listPlatformAuditLogs(tx, { ...auditQuery(input), limit: EXPORT_LIMIT + 1 });
          if (rows.length > EXPORT_LIMIT) throw new TRPCError({ code: "BAD_REQUEST", message: `${EXPORT_LIMIT} 件を超えます。期間を分けて出力してください` });
          await ctx.platformAudit(tx, { action: "platform_audit_log.export", detail: { ...input, count: rows.length } });
          return { rows };
        }),
      ),
  }),
});

/** モードに合わない項目は保存しない。保存前に料金計算できることを確かめる */
function planValues(p: z.infer<typeof planInput>) {
  const v = {
    name: p.name,
    baseFee: p.baseFee,
    billingMode: p.billingMode,
    unitPrice: p.billingMode === "per_unit" ? p.unitPrice : null,
    tiersJson: p.billingMode === "tiered" ? p.tiers : null,
  };
  resolvePricing({ id: "", ...v });
  return v;
}
