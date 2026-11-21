/**
 * 就労可否の判定(フェーズ2「就労可否の自動判定」の第 1 段階: カードの記載だけで判定する)。
 *
 * 判定は雇用主の確認を補助するためのもの。業務内容が在留資格の範囲に入るかなどは、雇用主が指定書・許可書・業務内容で確認する。
 * 区分:
 * - ok          就労可(職種・時間の制限なし)
 * - conditional 条件付きで可(在留資格の範囲の業務だけ、指定書の範囲だけ、資格外活動許可の範囲だけ)
 * - ng          就労不可(就労不可で資格外活動許可なし、在留期限切れ、失効)
 * - check       要確認(カード未登録、署名検証の失敗、就労制限の欄が未登録など)
 */
import { WORK_RESTRICTION_LABEL } from "./cards.js";
import type { ExpiryStatus } from "./expiry.js";

export const WORK_LEVELS = ["ok", "conditional", "ng", "check"] as const;
export type WorkLevel = (typeof WORK_LEVELS)[number];
export const WORK_LEVEL_LABEL: Record<WorkLevel, string> = {
  ok: "就労可",
  conditional: "条件付きで可",
  ng: "就労不可",
  check: "要確認",
};

export interface CardForWork {
  cardKind?: "residence" | "special_permanent" | null | undefined;
  statusOfResidence: string | null;
  workRestriction: string | null;
  /** 資格外活動許可(第2世代は IC のコード "0"/"1"/"2"、旧様式は裏面の記載の文字) */
  outsideActivity: string | null;
  outsideActivityUntil?: string | null | undefined;
  icVerified: boolean;
  needsReview: boolean;
  /** 最新の失効照会の結果(ok / revoked / unverifiable) */
  revocationResult?: string | null | undefined;
}

export interface WorkJudgement {
  level: WorkLevel;
  /** 判定の理由 */
  reasons: string[];
  /** 雇用主が確かめること */
  checks: string[];
  /** 資格外活動の時間の上限(週) */
  weeklyHoursLimit: number | null;
}

/** 資格外活動許可の読み取り。none: 許可なし / comprehensive: 包括許可(原則週 28 時間以内) / individual: 個別許可 */
export function outsidePermission(c: Pick<CardForWork, "outsideActivity" | "outsideActivityUntil">, today: string): { kind: "none" | "comprehensive" | "individual"; expired: boolean; detail: string | null } {
  const v = c.outsideActivity?.trim() ?? "";
  const expired = !!c.outsideActivityUntil && c.outsideActivityUntil < today;
  if (!v || v === "0" || /^無|許可なし|なし$/.test(v)) return { kind: "none", expired: false, detail: null };
  if (v === "1") return { kind: "comprehensive", expired, detail: "原則週28時間以内・風俗営業等の従事を除く" };
  if (v === "2") return { kind: "comprehensive", expired, detail: "原則週28時間以内・教育等の活動に限る" };
  if (/28/.test(v) || /包括/.test(v)) return { kind: "comprehensive", expired, detail: v };
  return { kind: "individual", expired, detail: v };
}

/** 在留資格ごとの、認められる業務の目安(雇用主が確認するための説明。網羅ではない) */
const STATUS_HINTS: [RegExp, string][] = [
  [/技術・人文知識・国際業務|技人国/, "専門的・技術的な業務(理系・文系の専門知識や外国の文化を生かす業務)に限られます。単純作業・現場作業が主になる業務はできません"],
  [/特定技能/, "指定書に記載された特定産業分野・業務区分と、受入れ機関(雇用契約の相手)での業務に限られます"],
  [/技能実習/, "実習実施者(受入れ企業)で、技能実習計画に沿った作業に限られます。転職・副業はできません"],
  [/特定活動/, "指定書に記載された活動に限られます(活動の内容は人によって異なります)"],
  [/企業内転勤/, "転勤元の事業所から転勤した事業所での、技術・人文知識・国際業務に当たる業務に限られます"],
  [/^技能$|技能(?!実習)/, "熟練した技能を要する業務(調理師・建築技術者など、在留資格の範囲)に限られます"],
  [/介護/, "介護福祉士の資格に基づく介護・介護の指導の業務に限られます"],
  [/高度専門職/, "指定書に記載された活動(研究・技術・経営など)に限られます"],
  [/経営・管理/, "事業の経営・管理の業務に限られます"],
  [/教授|教育|研究|医療|法律・会計|芸術|報道|宗教|興行/, "在留資格に定められた分野の業務に限られます"],
  [/留学|家族滞在|文化活動|短期滞在|研修/, "就労できない在留資格です。資格外活動許可の範囲でのみ働けます"],
];

export function statusHint(status: string | null): string | null {
  if (!status) return null;
  return STATUS_HINTS.find(([re]) => re.test(status))?.[1] ?? null;
}

export function judgeWorkEligibility(card: CardForWork | null, expiry: ExpiryStatus, today: string): WorkJudgement {
  const reasons: string[] = [];
  const checks: string[] = [];
  const result = (level: WorkLevel, weeklyHoursLimit: number | null = null): WorkJudgement => ({ level, reasons, checks, weeklyHoursLimit });

  if (!card) {
    reasons.push("在留カードが登録されていません");
    checks.push("在留カードを確認して登録してください");
    return result("check");
  }
  if (card.revocationResult === "revoked") {
    reasons.push("失効情報照会で「失効」と確認されています");
    checks.push("在留カードが有効か、本人と出入国在留管理庁に確認してください");
    return result("ng");
  }
  if (card.needsReview) {
    reasons.push("IC の署名検証に失敗しています(偽造の疑い)");
    checks.push("在留カードの真正性を確認してください(入管局・労働局に相談)");
    return result("check");
  }
  if (expiry.bucket === "expired") {
    reasons.push(`在留期限が切れています(${expiry.deadline})`);
    checks.push("在留期間の更新・変更の許可を受けたか、新しい在留カードを確認してください");
    return result("ng");
  }
  if (expiry.bucket === "pending") {
    checks.push(`更新申請中(特例期間 ${expiry.specialPeriodUntil} まで)。結果が出たら新しい在留カードを登録してください`);
  } else if (expiry.bucket === "within30") {
    checks.push(`在留期限が近づいています(${expiry.deadline})。更新の予定を確認してください`);
  }
  if (!card.icVerified) checks.push("IC で真正性を確認していません(券面の目視のみ)。IC 読み取りでの確認をおすすめします");

  if (card.cardKind === "special_permanent") {
    reasons.push("特別永住者(職種・時間の制限なし)");
    return result("ok");
  }

  const hint = statusHint(card.statusOfResidence);
  const status = card.statusOfResidence ? `在留資格「${card.statusOfResidence}」` : "在留資格";
  switch (card.workRestriction) {
    case "1":
      reasons.push(`${WORK_RESTRICTION_LABEL["1"]}(職種・時間の制限なし)`);
      return result("ok");
    case "2":
      reasons.push(`${WORK_RESTRICTION_LABEL["2"]}`);
      checks.push(`業務内容が${status}の範囲に入るか確認してください${hint ? `(${hint})` : ""}`);
      return result("conditional");
    case "4":
      reasons.push(`${WORK_RESTRICTION_LABEL["4"]}`);
      checks.push(`パスポートに貼られた指定書で、認められた活動・受入れ機関を確認してください${hint ? `(${hint})` : ""}`);
      return result("conditional");
    case "9": {
      const p = outsidePermission(card, today);
      if (p.kind === "none") {
        reasons.push(`${WORK_RESTRICTION_LABEL["9"]}で、資格外活動許可がありません`);
        checks.push("働く場合は、本人が資格外活動許可を受けている必要があります");
        return result("ng");
      }
      if (p.expired) {
        reasons.push(`資格外活動許可の期限が切れています(${card.outsideActivityUntil})`);
        checks.push("資格外活動許可が更新されたか確認してください");
        return result("ng");
      }
      reasons.push(`${WORK_RESTRICTION_LABEL["9"]}(資格外活動許可あり)`);
      if (p.kind === "comprehensive") {
        checks.push(`資格外活動の範囲で働けます: ${p.detail}。ほかの勤務先と合わせて週28時間を超えないよう管理してください(留学生は学則の長期休業中は1日8時間まで)`);
        return result("conditional", 28);
      }
      checks.push(`個別許可です。資格外活動許可書に記載された勤務先・業務の範囲だけで働けます${p.detail ? `(記載: ${p.detail})` : ""}`);
      return result("conditional");
    }
    default:
      reasons.push("就労制限の有無が登録されていません");
      checks.push("在留カード表面の「就労制限の有無」を確認して登録してください");
      return result("check");
  }
}
