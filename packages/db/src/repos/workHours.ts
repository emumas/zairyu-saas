/**
 * 勤怠(日ごとの労働時間)と長期休業期間(フェーズ2: 週28時間の確認)
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "../client.js";
import { studyBreaks, workDays } from "../schema.js";

const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

/** 同じ人・同じ日の行は置き換える(再取込で上書き) */
export async function upsertWorkDays(tx: Tx, rows: readonly { personId: string; workDate: string; minutes: number }[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await tx
      .insert(workDays)
      .values(chunk)
      .onConflictDoUpdate({ target: [workDays.personId, workDays.workDate], set: { minutes: sqlExcluded("minutes"), importedAt: new Date() } });
  }
}

export async function listWorkDays(tx: Tx, personIds: readonly string[], from: string, to: string) {
  if (personIds.length === 0) return [];
  return tx
    .select({ personId: workDays.personId, date: workDays.workDate, minutes: workDays.minutes })
    .from(workDays)
    .where(and(inArray(workDays.personId, [...personIds]), gte(workDays.workDate, from), lte(workDays.workDate, to)))
    .orderBy(asc(workDays.workDate));
}

export async function listStudyBreaks(tx: Tx, personIds: readonly string[]) {
  if (personIds.length === 0) return [];
  return tx
    .select({ id: studyBreaks.id, personId: studyBreaks.personId, fromDate: studyBreaks.fromDate, toDate: studyBreaks.toDate, note: studyBreaks.note })
    .from(studyBreaks)
    .where(inArray(studyBreaks.personId, [...personIds]))
    .orderBy(asc(studyBreaks.fromDate));
}

export async function insertStudyBreak(tx: Tx, v: { personId: string; fromDate: string; toDate: string; note: string | null }) {
  const [r] = await tx.insert(studyBreaks).values(v).returning({ id: studyBreaks.id });
  return r!.id;
}

/** 消した期間の登録者 ID(無ければ null) */
export async function deleteStudyBreak(tx: Tx, id: string): Promise<string | null> {
  const [r] = await tx.delete(studyBreaks).where(eq(studyBreaks.id, id)).returning({ personId: studyBreaks.personId });
  return r?.personId ?? null;
}

export async function findStudyBreak(tx: Tx, id: string) {
  const [r] = await tx.select({ personId: studyBreaks.personId }).from(studyBreaks).where(eq(studyBreaks.id, id));
  return r ?? null;
}
