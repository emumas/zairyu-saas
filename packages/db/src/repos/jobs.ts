/** 職種照合(テスト運用): 自社の職種と確認の記録 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { jobCategories, jobChecks, persons, tenants, users } from "../schema.js";

export async function jobMatchingEnabled(tx: Tx): Promise<boolean> {
  const [t] = await tx.select({ v: tenants.jobMatchingEnabled }).from(tenants);
  return t?.v ?? false;
}

export async function listJobCategories(tx: Tx) {
  return tx.select().from(jobCategories).orderBy(asc(jobCategories.name));
}

export async function getJobCategory(tx: Tx, id: string) {
  const [r] = await tx.select().from(jobCategories).where(eq(jobCategories.id, id));
  return r ?? null;
}

export async function insertJobCategory(tx: Tx, v: { name: string; simpleWork: boolean; adultEntertainment: boolean; sswField: string | null; note: string | null }) {
  const [r] = await tx.insert(jobCategories).values(v).returning({ id: jobCategories.id });
  return r!.id;
}

export async function updateJobCategory(
  tx: Tx,
  id: string,
  patch: Partial<{ name: string; simpleWork: boolean; adultEntertainment: boolean; sswField: string | null; note: string | null; archivedAt: Date | null }>,
): Promise<boolean> {
  const r = await tx.update(jobCategories).set(patch).where(eq(jobCategories.id, id)).returning({ id: jobCategories.id });
  return r.length > 0;
}

export async function setPersonJob(tx: Tx, personId: string, v: { jobCategoryId?: string | null; sswField?: string | null }): Promise<void> {
  await tx.update(persons).set({ ...v, updatedAt: new Date() }).where(eq(persons.id, personId));
}

export async function personJob(tx: Tx, personId: string) {
  const [r] = await tx.select({ jobCategoryId: persons.jobCategoryId, sswField: persons.sswField }).from(persons).where(eq(persons.id, personId));
  return r ?? null;
}

export async function insertJobCheck(
  tx: Tx,
  v: { personId: string; jobCategoryId: string; statusOfResidence: string | null; result: "ok" | "concern"; items: string[]; note: string | null; checkedBy: string },
) {
  const [r] = await tx.insert(jobChecks).values(v).returning({ id: jobChecks.id });
  return r!.id;
}

export async function listJobChecks(tx: Tx, personId: string) {
  return tx
    .select({
      id: jobChecks.id,
      jobCategoryId: jobChecks.jobCategoryId,
      jobName: jobCategories.name,
      statusOfResidence: jobChecks.statusOfResidence,
      result: jobChecks.result,
      items: jobChecks.items,
      note: jobChecks.note,
      checkedByEmail: users.email,
      checkedAt: jobChecks.checkedAt,
    })
    .from(jobChecks)
    .innerJoin(jobCategories, eq(jobCategories.id, jobChecks.jobCategoryId))
    .leftJoin(users, eq(users.id, jobChecks.checkedBy))
    .where(eq(jobChecks.personId, personId))
    .orderBy(desc(jobChecks.checkedAt));
}

/** この職種での最後の確認(在留資格が変わっていれば使わない) */
export async function lastJobCheck(tx: Tx, personId: string, jobCategoryId: string, statusOfResidence: string | null) {
  const [r] = await tx
    .select({ result: jobChecks.result, checkedAt: sql<string>`${jobChecks.checkedAt}::text` })
    .from(jobChecks)
    .where(
      and(
        eq(jobChecks.personId, personId),
        eq(jobChecks.jobCategoryId, jobCategoryId),
        statusOfResidence === null ? sql`${jobChecks.statusOfResidence} is null` : eq(jobChecks.statusOfResidence, statusOfResidence),
      ),
    )
    .orderBy(desc(jobChecks.checkedAt))
    .limit(1);
  return r ? { result: r.result as "ok" | "concern", checkedAt: r.checkedAt } : null;
}
