/** パスワード再設定のリンク(withTenant のトランザクションで呼ぶこと) */
import { and, count, eq, gte, isNull } from "drizzle-orm";
import type { Tx } from "../client.js";
import { passwordResets } from "../schema.js";

export async function insertPasswordReset(tx: Tx, v: { userId: string; tokenHash: Buffer; expiresAt: Date; createdBy: string | null }, now: Date): Promise<void> {
  // 以前の未使用のリンクは使えなくする
  await tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, v.userId), isNull(passwordResets.usedAt)));
  // 発行時刻はアプリの時計で入れる(連打の制限・有効期限と同じ時計で比べるため)
  await tx.insert(passwordResets).values({ ...v, createdAt: now });
}

/** 本人の申請の連打を防ぐ: since 以降に発行した数 */
export async function countRecentPasswordResets(tx: Tx, userId: string, since: Date): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(passwordResets).where(and(eq(passwordResets.userId, userId), gte(passwordResets.createdAt, since)));
  return r?.n ?? 0;
}

export async function findPasswordReset(tx: Tx, tokenHash: Buffer) {
  const [r] = await tx.select().from(passwordResets).where(eq(passwordResets.tokenHash, tokenHash));
  return r ?? null;
}

/** 使用済みにする(同時に 2 回使われても片方だけが成功する) */
export async function markPasswordResetUsed(tx: Tx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(passwordResets)
    .set({ usedAt: at })
    .where(and(eq(passwordResets.id, id), isNull(passwordResets.usedAt)))
    .returning({ id: passwordResets.id });
  return rows.length > 0;
}
