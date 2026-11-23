/** 就労制限の有無を、券面の文言や在留資格から決める(確定できるときだけ) */

export type WorkRestrictionCode = "1" | "2" | "4" | "9";

/**
 * 券面の「就労制限の有無」の欄の文言から(印字された文言なので確定)。読み取れなければ null
 */
export function workRestrictionFromText(text: string | null | undefined): WorkRestrictionCode | null {
  const t = (text ?? "").normalize("NFKC").replace(/\s/g, "");
  if (/指定書/.test(t)) return "4";
  if (/在留資格に基づく就労活動のみ可|資格に基づく就労/.test(t)) return "2";
  if (/就労不可/.test(t)) return "9";
  if (/就労制限なし/.test(t)) return "1";
  return null;
}

/** 在留資格だけで就労制限が決まるもの(活動に制限のない身分系の資格と、就労できない資格)。それ以外は null(券面か IC で確かめる) */
const UNRESTRICTED = ["永住者", "日本人の配偶者等", "永住者の配偶者等", "定住者", "特別永住者"];
const NOT_ALLOWED = ["留学", "家族滞在", "文化活動", "短期滞在", "研修"];
export function workRestrictionFromStatus(status: string | null | undefined): WorkRestrictionCode | null {
  const t = (status ?? "").normalize("NFKC").replace(/\s/g, "");
  if (!t) return null;
  // 「永住者の配偶者等」を「永住者」より先に見る必要はない(どちらも制限なし)
  if (UNRESTRICTED.some((u) => t === u || t.startsWith(u))) return "1";
  if (NOT_ALLOWED.some((u) => t === u)) return "9";
  return null;
}
