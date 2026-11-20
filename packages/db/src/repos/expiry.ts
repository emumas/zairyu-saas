/**
 * 期限区分の SQL 版(packages/shared/src/expiry.ts と同じ判定)。一覧の絞り込みと件数集計に使う。
 * 両者の一致は apps/api の結合テストでランダムな日付を使って確かめている
 */
import { SPECIAL_PERIOD_MONTHS, WITHIN_30_DAYS, WITHIN_90_DAYS, type ExpiryBucket } from "@zairyu/shared";
import { sql, type SQL } from "drizzle-orm";
import { residenceCards } from "../schema.js";

const deadline = sql`coalesce(${residenceCards.expiryDate}, ${residenceCards.cardValidUntil})`;

/** residence_cards(現在のカード)を左外部結合したクエリで使う */
export function expiryBucketSql(today: string): SQL<ExpiryBucket> {
  const t = sql`${today}::date`;
  return sql<ExpiryBucket>`(case
    when ${residenceCards.id} is null then 'noCard'
    when ${deadline} is null then 'noExpiry'
    when ${residenceCards.pendingApplication}
      and ${t} <= (${deadline} + make_interval(months => ${SPECIAL_PERIOD_MONTHS}))::date then 'pending'
    when ${deadline} < ${t} then 'expired'
    when ${deadline} - ${t} <= ${WITHIN_30_DAYS} then 'within30'
    when ${deadline} - ${t} <= ${WITHIN_90_DAYS} then 'within90'
    else 'ok'
  end)`;
}

export const icUnverifiedSql = sql<boolean>`(${residenceCards.id} is not null and not ${residenceCards.icVerified})`;
export const needsReviewSql = sql<boolean>`coalesce(${residenceCards.needsReview}, false)`;
