/**
 * 職種照合(テスト運用)。登録者の在留資格と、割り当てた自社の職種が合っているかの目安を出す。
 * - 在留資格だけで決まるもの(身分系=制限なし、資格外活動=風俗営業は不可)は判定する
 * - 特定技能は、指定書の分野(登録者に登録)と職種の分野を照らし合わせる
 * - 技術・人文知識・国際業務などは機械では決められないので「要確認」とし、確認項目と記録で補助する
 * 最終的な判断は雇用主が行う(画面に明記)。分野の一覧は制度の改正で変わるので、運営側で更新する
 */
import { z } from "zod";
import { outsidePermission } from "./work.js";

/** 特定技能の特定産業分野(2026 年の追加分を含む。受入れ開始の時期は分野ごとに異なるので画面で注意する) */
export const SSW_FIELDS = [
  ["kaigo", "介護"],
  ["building_cleaning", "ビルクリーニング"],
  ["industrial_products", "工業製品製造業"],
  ["construction", "建設"],
  ["shipbuilding", "造船・舶用工業"],
  ["auto_maintenance", "自動車整備"],
  ["aviation", "航空"],
  ["accommodation", "宿泊"],
  ["agriculture", "農業"],
  ["fishery", "漁業"],
  ["food_manufacturing", "飲食料品製造業"],
  ["food_service", "外食業"],
  ["auto_transport", "自動車運送業"],
  ["railway", "鉄道"],
  ["forestry", "林業"],
  ["wood_industry", "木材産業"],
  ["linen_supply", "リネンサプライ(2026年追加)"],
  ["logistics_warehouse", "物流倉庫(2026年追加)"],
  ["resource_recycling", "資源循環(2026年追加)"],
] as const;
export type SswField = (typeof SSW_FIELDS)[number][0];
export const SSW_FIELD_KEYS = SSW_FIELDS.map(([k]) => k) as [SswField, ...SswField[]];
export const SSW_FIELD_LABEL = Object.fromEntries(SSW_FIELDS) as Record<SswField, string>;

export interface JobCategory {
  name: string;
  /** 単純作業(ライン作業・清掃・梱包・接客レジなど)を含む */
  simpleWork: boolean;
  /** 風俗営業等(接待飲食など)に当たる */
  adultEntertainment: boolean;
  /** 特定技能の分野(この職種で特定技能の人が働ける分野) */
  sswField: string | null;
}

export interface JobMatchInput {
  card: {
    cardKind?: string | null;
    statusOfResidence: string | null;
    workRestriction: string | null;
    outsideActivity: string | null;
    outsideActivityUntil?: string | null;
  } | null;
  /** 指定書に記載された特定技能の分野(登録者に登録) */
  personSswField: string | null;
  job: JobCategory | null;
  /** この職種で最後に記録した確認(要確認の解消に使う) */
  lastCheck: { result: "ok" | "concern"; checkedAt: string } | null;
}

export type JobMatchLevel = "ok" | "check" | "ng" | "none";
export const JOB_MATCH_LEVEL_LABEL: Record<JobMatchLevel, string> = { ok: "問題なし", check: "要確認", ng: "不可の可能性", none: "職種が未設定" };

export interface JobMatch {
  level: JobMatchLevel;
  reasons: string[];
  /** 確認すること(記録の画面のチェック項目にも使う) */
  checks: string[];
}

/** 技術・人文知識・国際業務の確認項目 */
export const GIJINKOKU_CHECKS = [
  "業務は専門的な知識・技術・国際的な感性を要する内容か(単純作業が中心でない)",
  "大学・専門学校で学んだ内容、または職歴と業務に関連があるか",
  "現場での作業がある場合、日本人の新入社員と同じ合理的な期間の研修か(研修計画があるか)",
  "日本人と同等以上の報酬か",
] as const;

export function judgeJobMatch(input: JobMatchInput, today: string): JobMatch {
  const reasons: string[] = [];
  const checks: string[] = [];
  const out = (level: JobMatchLevel): JobMatch => ({ level, reasons, checks });
  const { card, job } = input;
  if (!job) {
    reasons.push("職種が割り当てられていません");
    return out("none");
  }
  if (!card) {
    reasons.push("在留カードが登録されていません");
    checks.push("在留カードを登録してください");
    return out("check");
  }
  const status = card.statusOfResidence ?? "";
  const confirmed = input.lastCheck?.result === "ok" ? input.lastCheck : null;

  // 身分系(特別永住者・永住者・日本人の配偶者等・永住者の配偶者等・定住者)は職種の制限なし
  if (card.cardKind === "special_permanent" || card.workRestriction === "1") {
    reasons.push("就労制限なし(職種の制限なし)");
    return out("ok");
  }

  // 就労不可+資格外活動(留学・家族滞在など)
  if (card.workRestriction === "9") {
    const p = outsidePermission({ outsideActivity: card.outsideActivity, outsideActivityUntil: card.outsideActivityUntil ?? null }, today);
    if (p.kind === "none" || p.expired) {
      reasons.push("就労不可で、有効な資格外活動許可がありません");
      return out("ng");
    }
    if (job.adultEntertainment) {
      reasons.push("資格外活動許可では、風俗営業等(接待飲食など)に当たる職種では働けません");
      return out("ng");
    }
    reasons.push(p.kind === "comprehensive" ? "資格外活動許可(包括)の範囲の職種です" : "資格外活動許可(個別)の範囲か、許可書で確認してください");
    if (p.kind === "comprehensive") checks.push("週28時間以内(長期休業中は1日8時間以内)で働かせてください");
    else checks.push("資格外活動許可書に記載された活動・勤務先の範囲か確認してください");
    return out(p.kind === "comprehensive" ? "ok" : "check");
  }

  if (job.adultEntertainment) {
    reasons.push("風俗営業等に当たる職種は、身分系の在留資格以外では原則として働けません");
    return out("ng");
  }

  // 特定技能: 指定書の分野と職種の分野が合っているか
  if (/特定技能/.test(status)) {
    if (!job.sswField) {
      reasons.push(`職種「${job.name}」に特定技能の分野が設定されていません`);
      checks.push("職種の画面で、この職種の特定技能の分野を設定してください");
      return out("check");
    }
    if (!input.personSswField) {
      reasons.push("登録者の指定書の分野が登録されていません");
      checks.push("パスポートの指定書を見て、登録者の「特定技能の分野」を登録してください");
      return out("check");
    }
    if (input.personSswField !== job.sswField) {
      reasons.push("指定書の分野と、職種の分野が違います");
      checks.push("分野の違う業務には従事できません。業務を見直すか、在留資格の変更が必要か確認してください");
      return out("ng");
    }
    reasons.push("指定書の分野と職種の分野が一致しています");
    checks.push("指定書に記載された受入れ機関(自社)での雇用か、業務区分の範囲か確認してください");
    return out(confirmed ? "ok" : "check");
  }

  // 技術・人文知識・国際業務: 機械では決められない
  if (/技術・人文知識・国際業務|企業内転勤/.test(status)) {
    if (job.simpleWork) reasons.push(`職種「${job.name}」は単純作業を含みます。単純作業が中心の業務はこの在留資格では認められません`);
    else reasons.push("専門的な業務に当たるか、確認が必要です");
    checks.push(...GIJINKOKU_CHECKS);
    if (confirmed && !job.simpleWork) {
      reasons.push(`確認済み(${confirmed.checkedAt.slice(0, 10)})`);
      return out("ok");
    }
    return out("check");
  }

  if (/技能実習|育成就労/.test(status)) {
    reasons.push("技能実習計画(育成就労計画)の職種・作業に限られます");
    checks.push("計画に記載された職種・作業と、この職種の業務が同じか確認してください");
    return out(confirmed ? "ok" : "check");
  }

  if (/特定活動/.test(status) || card.workRestriction === "4") {
    reasons.push("指定書に記載された活動に限られます");
    checks.push("パスポートの指定書に記載された活動の範囲か確認してください");
    return out(confirmed ? "ok" : "check");
  }

  if (/^\d+$/.test(status)) {
    reasons.push("在留資格がコード(第2世代の IC の値)のため、職種の照合は券面で確認してください");
  } else {
    reasons.push(status ? `在留資格「${status}」の範囲の業務か確認が必要です` : "在留資格が登録されていません");
  }
  if (job.simpleWork) checks.push("単純作業を含む職種です。在留資格の範囲か特に注意してください");
  checks.push("在留資格で認められた業務の範囲か確認してください");
  return out(confirmed ? "ok" : "check");
}

export const jobCategoryInput = z.object({
  name: z.string().trim().min(1, "職種名を入力してください").max(50),
  simpleWork: z.boolean(),
  adultEntertainment: z.boolean(),
  sswField: z.enum(SSW_FIELD_KEYS).nullable(),
  note: z.string().trim().max(200).nullish(),
});

export const jobCheckInput = z.object({
  personId: z.uuid(),
  result: z.enum(["ok", "concern"]),
  /** チェックした確認項目 */
  items: z.array(z.string().max(200)).max(20),
  note: z.string().trim().max(500).nullish(),
});
