/**
 * アラート(1-13)の判定と通知文。
 * 通知文には件数だけを入れ、氏名・カード番号などは入れない(ロック画面やメールに表示されるため)
 */
import { alertDueDates, classifyExpiry, type CardForExpiry } from "./expiry.js";

export type ExpiryAlertType = "expiry_90" | "expiry_60" | "expiry_30" | "expired";
export type AlertType = ExpiryAlertType | "needs_review" | "recheck_revocation" | "hours_limit";

export const ALERT_LABEL: Record<AlertType, string> = {
  expiry_90: "期限まで90日",
  expiry_60: "期限まで60日",
  expiry_30: "期限まで30日",
  expired: "期限当日・期限切れ",
  needs_review: "要確認(署名検証に失敗)",
  recheck_revocation: "失効情報の再照会",
  hours_limit: "就労時間の上限",
};

/**
 * 今日の時点で出すべき期限アラート(いちばん新しい段階の 1 つだけ)。
 * 古い段階(90 日前など)をまとめて出さないため、登録が期限間近でも通知は 1 回になる。
 * 更新申請中(特例期間内)・期限なし・カード未登録は出さない
 */
export function expiryAlertFor(card: CardForExpiry | null, today: string): { type: ExpiryAlertType; dueDate: string } | null {
  const s = classifyExpiry(card, today);
  if (!s.deadline || s.bucket === "pending" || s.bucket === "noExpiry" || s.bucket === "noCard") return null;
  const due = alertDueDates(s.deadline).filter((a) => a.dueDate <= today);
  return due.at(-1) ?? null;
}

export interface NotificationPayload {
  title: string;
  body: string;
  /** 通知の種類(アプリでの表示切り替え用) */
  kind: "expiry_digest" | "needs_review";
}

/** 期限アラートのまとめ通知(受け取る人ごとに件数を数える) */
export function expiryDigest(counts: Partial<Record<ExpiryAlertType, number>>): NotificationPayload | null {
  const parts: string[] = [];
  if (counts.expired) parts.push(`期限当日・期限切れ ${counts.expired}名`);
  if (counts.expiry_30) parts.push(`30日以内 ${counts.expiry_30}名`);
  if (counts.expiry_60) parts.push(`60日以内 ${counts.expiry_60}名`);
  if (counts.expiry_90) parts.push(`90日以内 ${counts.expiry_90}名`);
  if (parts.length === 0) return null;
  return {
    kind: "expiry_digest",
    title: "在留カードの期限のお知らせ",
    body: `${parts.join("、")}。アプリで対象者を確認してください。`,
  };
}

export function needsReviewNotice(): NotificationPayload {
  return {
    kind: "needs_review",
    title: "要確認のカードが登録されました",
    body: "電子署名の検証に失敗したカードが登録されました(偽造の疑い)。アプリで確認し、入管局・労働局に相談してください。",
  };
}
