/**
 * 組織管理(1-15、テナント管理者のみ): 拠点・ユーザー・招待。
 * - 自分自身の停止・ロール変更はできない
 * - 有効なテナント管理者が 0 人になる変更はできない
 * - 停止・ロール変更ではそのユーザーのリフレッシュトークンを失効させる(権限は毎リクエスト DB から引き直すので即時に効く)
 */
import {
  countActiveTenantAdmins,
  createSite,
  getUser,
  insertInvitedUser,
  getEmployerInfo,
  listSites,
  listUsers,
  revokeUserTokens,
  setUserSites,
  updateSite,
  updateUser,
  schema,
  type Tx,
} from "@zairyu/db";
import { eq } from "drizzle-orm";
import { dateString, inviteUserInput, jstDate, siteNameInput, USER_ROLES } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Actor } from "../authz/permissions.js";
import { issueInvitation } from "../invitations.js";
import { permissionProcedure, router } from "../trpc.js";

const p = permissionProcedure("org.manage");
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

async function assertSitesExist(tx: Tx, siteIds: readonly string[]) {
  if (siteIds.length === 0) return;
  const all = await listSites(tx);
  const active = new Set(all.filter((s) => !s.archivedAt).map((s) => s.id));
  if (!siteIds.every((id) => active.has(id))) throw new TRPCError({ code: "BAD_REQUEST", message: "拠点が見つかりません" });
}

/** 有効なテナント管理者が残ることを確かめる */
async function assertAdminRemains(tx: Tx, userId: string) {
  if ((await countActiveTenantAdmins(tx, userId)) === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "有効なテナント管理者が 1 人以上必要です" });
  }
}

function assertNotSelf(actor: Actor, userId: string) {
  if (actor.userId === userId) throw new TRPCError({ code: "BAD_REQUEST", message: "自分自身には実行できません" });
}


const userOutput = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(["invited", "active", "suspended"]),
  totpEnabled: z.boolean(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  siteIds: z.array(z.string()),
});

/** 空欄は null にする任意の文字列 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

export const orgRouter = router({
  sites: router({
    list: p
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            archivedAt: z.date().nullable(),
            createdAt: z.date(),
            officialName: z.string().nullable(),
            address: z.string().nullable(),
            phone: z.string().nullable(),
            insuranceOfficeNumber: z.string().nullable(),
          }),
        ),
      )
      .query(({ ctx }) => ctx.tenantTx((tx) => listSites(tx))),

    create: p
      .input(z.object({ name: siteNameInput }))
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const id = await createSite(tx, input.name);
          await ctx.audit(tx, { action: "site.create", targetType: "site", targetId: id });
          return { id };
        }),
      ),

    update: p
      .input(
        z.object({
          id: z.uuid(),
          name: siteNameInput.optional(),
          archived: z.boolean().optional(),
          // 外国人雇用状況の届出に書く事業所の情報(空欄は null)
          officialName: optionalText(100),
          address: optionalText(200),
          phone: optionalText(20),
          insuranceOfficeNumber: z
            .string()
            .trim()
            .regex(/^$|^[0-9-]{11,15}$/, "雇用保険適用事業所番号は数字とハイフンで入力してください(例: 1234-567890-1)")
            .transform((v) => v || null)
            .nullish(),
        }),
      )
      .output(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const patch = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date(ctx.services.now()) : null } : {}),
            ...(input.officialName !== undefined ? { officialName: input.officialName } : {}),
            ...(input.address !== undefined ? { address: input.address } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.insuranceOfficeNumber !== undefined ? { insuranceOfficeNumber: input.insuranceOfficeNumber } : {}),
          };
          if (!(await updateSite(tx, input.id, patch))) throw notFound();
          await ctx.audit(tx, { action: "site.update", targetType: "site", targetId: input.id, detail: { fields: Object.keys(patch) } });
          return { id: input.id };
        }),
      ),
  }),

  users: router({
    list: p.output(z.array(userOutput)).query(({ ctx }) => ctx.tenantTx((tx) => listUsers(tx))),

    /** 招待する(招待リンクはメールで送り、開発中・メール未設定でも管理者が渡せるよう応答にも含める) */
    invite: p
      .input(inviteUserInput)
      .output(z.object({ userId: z.string(), inviteUrl: z.string(), expiresAt: z.date() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const siteIds = input.role === "tenant_admin" ? [] : input.siteIds;
          await assertSitesExist(tx, siteIds);
          let userId: string;
          try {
            userId = await insertInvitedUser(tx, { email: input.email, role: input.role });
          } catch (e) {
            const err = e as { code?: string; cause?: { code?: string } };
            if ((err.code ?? err.cause?.code) === "23505") {
              throw new TRPCError({ code: "CONFLICT", message: "このメールアドレスは既に登録されています" });
            }
            throw e;
          }
          await setUserSites(tx, userId, siteIds);
          const inv = await issueInvitation(ctx.services, tx, { tenantId: ctx.actor.tenantId, userId, email: input.email, createdBy: ctx.actor.userId });
          await ctx.audit(tx, { action: "user.invite", targetType: "user", targetId: userId, detail: { role: input.role } });
          return { userId, inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt };
        }),
      ),

    /** パスワード再設定のリンクを発行する(本人にもメールで送る。メールが届かないときは画面のリンクを伝える) */
    issuePasswordReset: p
      .input(z.object({ userId: z.uuid() }))
      .output(z.object({ url: z.string(), expiresAt: z.date() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const u = await getUser(tx, input.userId);
          if (!u) throw notFound();
          if (u.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "有効なユーザーだけに発行できます(招待中なら再招待してください)" });
          const r = await ctx.services.auth.issuePasswordReset(tx, ctx.actor.tenantId, u.id, ctx.actor.userId);
          await ctx.audit(tx, { action: "user.password_reset_issued", targetType: "user", targetId: u.id });
          return r;
        }),
      ),

    /** 認証アプリのリセット(スマホをなくした場合)。本人は次のログインで設定し直す */
    resetTotp: p
      .input(z.object({ userId: z.uuid() }))
      .output(z.object({ userId: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          assertNotSelf(ctx.actor, input.userId);
          const u = await getUser(tx, input.userId);
          if (!u) throw notFound();
          await ctx.services.auth.resetTotp(tx, u.id);
          await ctx.audit(tx, { action: "user.totp_reset", targetType: "user", targetId: u.id });
          return { userId: u.id };
        }),
      ),

    /** 招待リンクを出し直す(以前のリンクは使えなくなる) */
    reinvite: p
      .input(z.object({ userId: z.uuid() }))
      .output(z.object({ inviteUrl: z.string(), expiresAt: z.date() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const u = await getUser(tx, input.userId);
          if (!u) throw notFound();
          if (u.status !== "invited") throw new TRPCError({ code: "BAD_REQUEST", message: "招待中のユーザーだけ再招待できます" });
          const inv = await issueInvitation(ctx.services, tx, { tenantId: ctx.actor.tenantId, userId: u.id, email: u.email, createdBy: ctx.actor.userId });
          await ctx.audit(tx, { action: "user.reinvite", targetType: "user", targetId: u.id });
          return { inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt };
        }),
      ),

    /** ロールと担当拠点の変更 */
    update: p
      .input(z.object({ userId: z.uuid(), role: z.enum(USER_ROLES).optional(), siteIds: z.array(z.uuid()).max(200).optional() }))
      .output(z.object({ userId: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const u = await getUser(tx, input.userId);
          if (!u) throw notFound();
          const fields: string[] = [];
          if (input.role && input.role !== u.role) {
            assertNotSelf(ctx.actor, u.id);
            if (u.role === "tenant_admin" && u.status === "active") await assertAdminRemains(tx, u.id);
            await updateUser(tx, u.id, { role: input.role });
            await revokeUserTokens(tx, u.id, new Date(ctx.services.now()));
            fields.push("role");
          }
          const role = input.role ?? u.role;
          if (input.siteIds) {
            const siteIds = role === "tenant_admin" ? [] : input.siteIds;
            await assertSitesExist(tx, siteIds);
            await setUserSites(tx, u.id, siteIds);
            fields.push("sites");
          }
          if (fields.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "変更する項目がありません" });
          await ctx.audit(tx, { action: "user.update", targetType: "user", targetId: u.id, detail: { fields, role } });
          return { userId: u.id };
        }),
      ),

    /** 利用停止・再開 */
    setActive: p
      .input(z.object({ userId: z.uuid(), active: z.boolean() }))
      .output(z.object({ userId: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const u = await getUser(tx, input.userId);
          if (!u) throw notFound();
          assertNotSelf(ctx.actor, u.id);
          if (input.active) {
            if (u.status !== "suspended") throw new TRPCError({ code: "BAD_REQUEST", message: "停止中のユーザーだけ再開できます" });
            await updateUser(tx, u.id, { status: "active" });
          } else {
            if (u.status === "suspended") throw new TRPCError({ code: "BAD_REQUEST", message: "すでに停止中です" });
            if (u.role === "tenant_admin" && u.status === "active") await assertAdminRemains(tx, u.id);
            await updateUser(tx, u.id, { status: "suspended" });
            await revokeUserTokens(tx, u.id, new Date(ctx.services.now()));
          }
          await ctx.audit(tx, { action: input.active ? "user.reactivate" : "user.suspend", targetType: "user", targetId: u.id });
          return { userId: u.id };
        }),
      ),
  }),

  /**
   * テナント設定: 退職後の保存期間(3〜5 年。過ぎたら自動削除 1-21)と、
   * 監査ログの保存期間(5〜10 年。退職後の保存期間より短くならない。過ぎた記録は毎日の処理で削除)
   */
  settings: router({
    /** 外国人雇用状況の届出に書く事業主の情報 */
    employer: permissionProcedure("tenant.settings")
      .output(z.object({ name: z.string().nullable(), address: z.string().nullable(), phone: z.string().nullable(), representativeName: z.string().nullable(), noticesFrom: z.string() }))
      .query(({ ctx }) =>
        ctx.tenantTx(async (tx) => {
          const e = await getEmployerInfo(tx);
          if (!e) throw notFound();
          return { name: e.name, address: e.address, phone: e.phone, representativeName: e.representativeName, noticesFrom: e.noticesFrom };
        }),
      ),
    updateEmployer: permissionProcedure("tenant.settings")
      .input(
        z.object({
          name: optionalText(100),
          address: optionalText(200),
          phone: optionalText(20),
          representativeName: optionalText(50),
          /** 届出の管理を始める日(この日以後の雇入れ・離職を一覧に出す) */
          noticesFrom: dateString.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const set = {
            ...(input.name !== undefined ? { employerName: input.name } : {}),
            ...(input.address !== undefined ? { employerAddress: input.address } : {}),
            ...(input.phone !== undefined ? { employerPhone: input.phone } : {}),
            ...(input.representativeName !== undefined ? { representativeName: input.representativeName } : {}),
            ...(input.noticesFrom !== undefined ? { noticesFrom: input.noticesFrom } : {}),
          };
          if (input.noticesFrom && input.noticesFrom > jstDate(ctx.services.now())) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "届出の管理を始める日は今日以前にしてください" });
          }
          if (Object.keys(set).length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "変更する項目がありません" });
          await tx.update(schema.tenants).set(set).where(eq(schema.tenants.id, ctx.actor.tenantId));
          await ctx.audit(tx, { action: "tenant.employer_update", targetType: "tenant", targetId: ctx.actor.tenantId, detail: { fields: Object.keys(set).sort() } });
          return { ok: true as const };
        }),
      ),
    get: permissionProcedure("tenant.settings")
      .output(z.object({ name: z.string(), retentionYears: z.number(), auditRetentionYears: z.number() }))
      .query(({ ctx }) =>
        ctx.tenantTx(async (tx) => {
          const [t] = await tx
            .select({ name: schema.tenants.name, retentionYears: schema.tenants.retentionYears, auditRetentionYears: schema.tenants.auditRetentionYears })
            .from(schema.tenants);
          if (!t) throw notFound();
          return t;
        }),
      ),
    update: permissionProcedure("tenant.settings")
      .input(
        z
          .object({ retentionYears: z.number().int().min(3).max(5).optional(), auditRetentionYears: z.number().int().min(5).max(10).optional() })
          .refine((v) => v.retentionYears !== undefined || v.auditRetentionYears !== undefined, "変更する項目がありません"),
      )
      .output(z.object({ retentionYears: z.number(), auditRetentionYears: z.number() }))
      .mutation(({ ctx, input }) =>
        ctx.tenantTx(async (tx) => {
          const [before] = await tx.select({ retentionYears: schema.tenants.retentionYears, auditRetentionYears: schema.tenants.auditRetentionYears }).from(schema.tenants);
          if (!before) throw notFound();
          const after = { retentionYears: input.retentionYears ?? before.retentionYears, auditRetentionYears: input.auditRetentionYears ?? before.auditRetentionYears };
          await tx.update(schema.tenants).set({ ...after, updatedAt: new Date() }).where(eq(schema.tenants.id, ctx.actor.tenantId));
          if (after.retentionYears !== before.retentionYears) {
            await ctx.audit(tx, { action: "tenant.retention_update", targetType: "tenant", targetId: ctx.actor.tenantId, detail: { from: before.retentionYears, to: after.retentionYears } });
          }
          if (after.auditRetentionYears !== before.auditRetentionYears) {
            await ctx.audit(tx, { action: "tenant.audit_retention_update", targetType: "tenant", targetId: ctx.actor.tenantId, detail: { from: before.auditRetentionYears, to: after.auditRetentionYears } });
          }
          if (after.retentionYears === before.retentionYears && after.auditRetentionYears === before.auditRetentionYears) {
            await ctx.audit(tx, { action: "tenant.settings_unchanged", targetType: "tenant", targetId: ctx.actor.tenantId });
          }
          return after;
        }),
      ),
  }),
});
