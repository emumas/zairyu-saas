/**
 * 運営者コンソール(1-19)。withPlatform のトランザクションで呼ぶこと。
 * 運営者は登録者・カード・確認履歴を見ない。テナントについては契約と人数(件数)だけを扱う
 */
import { and, asc, count, desc, eq, gte, like, lt, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { billingPeriods, dailyCounts, plans, platformAuditLogs, platformOperators, tenantPriceOverrides, tenants } from "../schema.js";

export async function listTenantsForPlatform(tx: Tx) {
  const latest = tx
    .selectDistinctOn([dailyCounts.tenantId], { tenantId: dailyCounts.tenantId, date: dailyCounts.date, activeCount: dailyCounts.activeCount })
    .from(dailyCounts)
    .orderBy(dailyCounts.tenantId, desc(dailyCounts.date))
    .as("latest");
  return tx
    .select({
      id: tenants.id,
      name: tenants.name,
      status: tenants.status,
      planId: tenants.planId,
      planName: plans.name,
      retentionYears: tenants.retentionYears,
      pastDueSince: tenants.pastDueSince,
      createdAt: tenants.createdAt,
      latestCountDate: latest.date,
      latestCount: latest.activeCount,
      hasOverride: sql<boolean>`exists (select 1 from ${tenantPriceOverrides} o where o.tenant_id = ${tenants.id}
        and (o.base_fee is not null or o.unit_price is not null or o.tiers_json is not null))`,
    })
    .from(tenants)
    .leftJoin(plans, eq(plans.id, tenants.planId))
    .leftJoin(latest, eq(latest.tenantId, tenants.id))
    .orderBy(asc(tenants.createdAt));
}

export async function getTenantForPlatform(tx: Tx, id: string) {
  const [t] = await tx.select().from(tenants).where(eq(tenants.id, id));
  if (!t) return null;
  const [override] = await tx.select().from(tenantPriceOverrides).where(eq(tenantPriceOverrides.tenantId, id));
  const periods = await tx
    .select({ period: billingPeriods.period, peakCount: billingPeriods.peakCount, amount: billingPeriods.amount, status: billingPeriods.status })
    .from(billingPeriods)
    .where(eq(billingPeriods.tenantId, id))
    .orderBy(desc(billingPeriods.period))
    .limit(12);
  const daily = await tx
    .select({ date: dailyCounts.date, activeCount: dailyCounts.activeCount })
    .from(dailyCounts)
    .where(eq(dailyCounts.tenantId, id))
    .orderBy(desc(dailyCounts.date))
    .limit(31);
  return { tenant: t, override: override ?? null, periods, daily: daily.reverse() };
}

export async function insertTenant(tx: Tx, v: { name: string; status: "trial" | "active"; planId: string | null }): Promise<string> {
  const [row] = await tx.insert(tenants).values(v).returning({ id: tenants.id });
  return row!.id;
}

export async function updateTenantByPlatform(
  tx: Tx,
  id: string,
  patch: Partial<{ name: string; status: "trial" | "active" | "past_due" | "suspended"; planId: string | null; retentionYears: number; pastDueSince: Date | null }>,
): Promise<boolean> {
  const rows = await tx
    .update(tenants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning({ id: tenants.id });
  return rows.length > 0;
}

export async function listPlansForPlatform(tx: Tx) {
  return tx
    .select({
      id: plans.id,
      name: plans.name,
      baseFee: plans.baseFee,
      billingMode: plans.billingMode,
      unitPrice: plans.unitPrice,
      tiersJson: plans.tiersJson,
      createdAt: plans.createdAt,
      tenantCount: sql<number>`(select count(*)::int from ${tenants} t where t.plan_id = ${plans.id})`,
    })
    .from(plans)
    .orderBy(asc(plans.createdAt));
}

export async function planExists(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx.select({ n: count() }).from(plans).where(eq(plans.id, id));
  return (row?.n ?? 0) > 0;
}

type PlanValues = { name: string; baseFee: number; billingMode: "per_unit" | "tiered"; unitPrice: number | null; tiersJson: unknown };

export async function insertPlan(tx: Tx, v: PlanValues): Promise<string> {
  const [row] = await tx.insert(plans).values(v).returning({ id: plans.id });
  return row!.id;
}

export async function updatePlan(tx: Tx, id: string, v: PlanValues): Promise<boolean> {
  const rows = await tx.update(plans).set(v).where(eq(plans.id, id)).returning({ id: plans.id });
  return rows.length > 0;
}

/** 個別単価を設定する(テナントにつき 1 件。すべて null にすると上書きなし) */
export async function upsertPriceOverride(
  tx: Tx,
  tenantId: string,
  v: { planId: string | null; baseFee: number | null; unitPrice: number | null; tiersJson: unknown },
): Promise<void> {
  await tx
    .insert(tenantPriceOverrides)
    .values({ tenantId, ...v })
    .onConflictDoUpdate({ target: tenantPriceOverrides.tenantId, set: v });
}

export interface PlatformAuditQuery {
  from: Date;
  to: Date;
  operatorId?: string | undefined;
  /** テナントに関わる操作(target_type = tenant)をテナントで絞る */
  tenantId?: string | undefined;
  /** 操作の種類の先頭一致(例: tenant. / operator.login) */
  action?: string | undefined;
  /** これより古い記録(id が小さい)だけ。ページ送り用 */
  beforeId?: number | undefined;
  limit: number;
}

/** 運営者の操作記録(新しい順)。運営者のメールアドレスと、対象のテナント名・プラン名を付ける */
export async function listPlatformAuditLogs(tx: Tx, q: PlatformAuditQuery) {
  const l = platformAuditLogs;
  return tx
    .select({
      id: l.id,
      at: l.at,
      operatorEmail: platformOperators.email,
      action: l.action,
      targetType: l.targetType,
      targetId: l.targetId,
      targetName: sql<string | null>`coalesce(${tenants.name}, ${plans.name})`,
      detail: l.detail,
      ip: sql<string | null>`host(${l.ip})`,
    })
    .from(l)
    .leftJoin(platformOperators, eq(platformOperators.id, l.operatorId))
    .leftJoin(tenants, and(eq(l.targetType, "tenant"), eq(sql`${tenants.id}::text`, l.targetId)))
    .leftJoin(plans, and(eq(l.targetType, "plan"), eq(sql`${plans.id}::text`, l.targetId)))
    .where(
      and(
        gte(l.at, q.from),
        lt(l.at, q.to),
        q.operatorId ? eq(l.operatorId, q.operatorId) : undefined,
        q.tenantId ? and(eq(l.targetType, "tenant"), eq(l.targetId, q.tenantId)) : undefined,
        q.action ? like(l.action, `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
        q.beforeId !== undefined ? lt(l.id, q.beforeId) : undefined,
      ),
    )
    .orderBy(desc(l.id))
    .limit(q.limit);
}

export async function listPlatformOperators(tx: Tx) {
  return tx
    .select({ id: platformOperators.id, email: platformOperators.email, disabledAt: platformOperators.disabledAt })
    .from(platformOperators)
    .orderBy(asc(platformOperators.email));
}
