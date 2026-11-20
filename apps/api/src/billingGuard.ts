/**
 * 未払い時の制御(1-18)。猶予期間を過ぎたテナントは、課金対象の人数を増やす操作
 * (登録者の追加・CSV 取込の新規・復職)だけを止める。閲覧・期限アラート・カード登録・IC 再検証・失効照会は止めない
 * (在留期限の管理を止めると、雇用主が不法就労助長のリスクを負うため)
 */
import { schema, type Tx } from "@zairyu/db";
import { billingRestriction, RESTRICTED_MESSAGE, type BillingRestriction } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";

/** このテナントの状態(tenantTx の中で呼ぶ。RLS で自テナントの行だけが見える) */
export async function tenantRestriction(tx: Tx, nowMs: number): Promise<BillingRestriction> {
  const [t] = await tx.select({ status: schema.tenants.status, pastDueSince: schema.tenants.pastDueSince }).from(schema.tenants);
  return t ? billingRestriction(t.status, t.pastDueSince, nowMs) : { state: "ok" };
}

export async function assertCanAddPersons(tx: Tx, nowMs: number): Promise<void> {
  if ((await tenantRestriction(tx, nowMs)).state === "restricted") throw new TRPCError({ code: "FORBIDDEN", message: RESTRICTED_MESSAGE });
}
