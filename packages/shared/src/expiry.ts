/**
 * 期限区分(1-11)。日付はすべて JST の YYYY-MM-DD。
 * 同じ判定を SQL でも行う(packages/db/src/repos/expiry.ts)。両者の一致はテストで確かめている。
 *
 * - 基準日は在留期間の満了日。無い場合(永住者など)はカードの有効期限
 * - 更新申請中は、満了日から 2 か月を経過する日までは在留できる(特例期間。入管法 20 条 6 項)。
 *   特例期間の終わりは「満了日の 2 か月後の応当日」(月末は丸める)とした。要法務確認
 * - 区分は 1 人 1 つ。IC 未検証・要確認は区分と重なりうる目印として別に持つ
 */
import { addDays, daysBetween } from "./jst.js";

export const EXPIRY_BUCKETS = ["expired", "within30", "within90", "pending", "ok", "noExpiry", "noCard"] as const;
export type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number];

export const EXPIRY_BUCKET_LABEL: Record<ExpiryBucket, string> = {
  expired: "期限切れ",
  within30: "30日以内",
  within90: "90日以内",
  pending: "更新申請中",
  ok: "期限まで余裕あり",
  noExpiry: "期限なし",
  noCard: "カード未登録",
};

/** 30 日以内・90 日以内の境界(当日を 0 日とする) */
export const WITHIN_30_DAYS = 30;
export const WITHIN_90_DAYS = 90;
/** 特例期間の長さ(月) */
export const SPECIAL_PERIOD_MONTHS = 2;

export interface CardForExpiry {
  expiryDate: string | null;
  cardValidUntil: string | null;
  pendingApplication: boolean;
  icVerified: boolean;
  needsReview: boolean;
}

export interface ExpiryStatus {
  bucket: ExpiryBucket;
  /** 判定に使った期限 */
  deadline: string | null;
  deadlineBasis: "stay" | "card" | null;
  /** 期限までの日数(当日 0、過ぎたら負) */
  daysLeft: number | null;
  /** 更新申請中の場合の特例期間の終わり */
  specialPeriodUntil: string | null;
  icUnverified: boolean;
  needsReview: boolean;
}

/** n か月後の応当日。存在しなければ月末(PostgreSQL の date + interval 'n months' と同じ) */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function classifyExpiry(card: CardForExpiry | null, today: string): ExpiryStatus {
  if (!card) {
    return { bucket: "noCard", deadline: null, deadlineBasis: null, daysLeft: null, specialPeriodUntil: null, icUnverified: false, needsReview: false };
  }
  const flags = { icUnverified: !card.icVerified, needsReview: card.needsReview };
  const deadline = card.expiryDate ?? card.cardValidUntil;
  const deadlineBasis = card.expiryDate ? "stay" : card.cardValidUntil ? "card" : null;
  if (!deadline) return { bucket: "noExpiry", deadline: null, deadlineBasis: null, daysLeft: null, specialPeriodUntil: null, ...flags };

  const daysLeft = daysBetween(today, deadline);
  const specialPeriodUntil = card.pendingApplication ? addMonths(deadline, SPECIAL_PERIOD_MONTHS) : null;
  let bucket: ExpiryBucket;
  if (specialPeriodUntil && today <= specialPeriodUntil) bucket = "pending";
  else if (daysLeft < 0) bucket = "expired";
  else if (daysLeft <= WITHIN_30_DAYS) bucket = "within30";
  else if (daysLeft <= WITHIN_90_DAYS) bucket = "within90";
  else bucket = "ok";
  return { bucket, deadline, deadlineBasis, daysLeft, specialPeriodUntil, ...flags };
}

/** アラート(1-13)の通知日: 期限の 90・60・30 日前と当日 */
export function alertDueDates(deadline: string): { type: "expiry_90" | "expiry_60" | "expiry_30" | "expired"; dueDate: string }[] {
  return [
    { type: "expiry_90", dueDate: addDays(deadline, -90) },
    { type: "expiry_60", dueDate: addDays(deadline, -60) },
    { type: "expiry_30", dueDate: addDays(deadline, -30) },
    { type: "expired", dueDate: deadline },
  ];
}
