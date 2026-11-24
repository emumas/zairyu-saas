/**
 * 外国人雇用状況の届出(第1段階: 期限の管理・記入内容の一覧・提出の記録)。
 * - 雇用保険の被保険者: 雇用保険被保険者資格取得届・資格喪失届の外国人の欄で届け出る
 *   期限: 雇入れは翌月 10 日まで。離職は、被保険者でなくなった日(離職日の翌日)の翌日から起算して 10 日以内
 * - 被保険者でない人: 外国人雇用状況届出書(様式第3号)。雇入れ・離職とも翌月末日まで
 * - 特別永住者は届出の対象外
 * 期限はハローワークの案内で確かめること(画面にも書く)。このアプリは事業主が自分で提出するための補助で、提出の代行はしない
 */
import { z } from "zod";
import { addDays } from "./jst.js";
import { dateString } from "./persons.js";
import { outsidePermission } from "./work.js";

export const NOTICE_KINDS = ["hire", "separation"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = { hire: "雇入れ", separation: "離職" };

export const NOTICE_METHODS = ["hellowork_internet", "e_gov", "window", "mail", "other"] as const;
export type NoticeMethod = (typeof NOTICE_METHODS)[number];
export const NOTICE_METHOD_LABEL: Record<NoticeMethod, string> = {
  hellowork_internet: "ハローワークインターネットサービス",
  e_gov: "e-Gov 電子申請",
  window: "ハローワークの窓口",
  mail: "郵送",
  other: "その他(社労士への依頼など)",
};

export type NoticeStatus = "pending" | "submitted" | "not_required";
export const NOTICE_STATUS_LABEL: Record<NoticeStatus, string> = { pending: "未提出", submitted: "提出済み", not_required: "届出不要" };

/** 月末の日付(YYYY-MM-DD) */
function endOfNextMonth(date: string): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const d = new Date(Date.UTC(y, m + 1, 0)); // 翌月の末日
  return d.toISOString().slice(0, 10);
}
function tenthOfNextMonth(date: string): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return new Date(Date.UTC(y, m, 10)).toISOString().slice(0, 10);
}

/** 書式の名前 */
export function noticeForm(kind: NoticeKind, insured: boolean | null): string {
  if (insured === true) return kind === "hire" ? "雇用保険被保険者資格取得届(外国人の欄)" : "雇用保険被保険者資格喪失届(外国人の欄)";
  if (insured === false) return "外国人雇用状況届出書(様式第3号)";
  return "雇用保険の加入が未設定(書式が決まりません)";
}

/**
 * 提出期限。雇用保険の加入が未設定(null)なら、早いほうの期限を返す(設定を促す)
 */
export function noticeDueDate(kind: NoticeKind, eventDate: string, insured: boolean | null): string {
  const insuredDue = kind === "hire" ? tenthOfNextMonth(eventDate) : addDays(eventDate, 11);
  const otherDue = endOfNextMonth(eventDate);
  if (insured === true) return insuredDue;
  if (insured === false) return otherDue;
  return insuredDue < otherDue ? insuredDue : otherDue;
}

/** 届出に書く値(API が集めて返す)。値が無ければ null */
export interface NoticeSource {
  kind: NoticeKind;
  eventDate: string;
  name: string;
  nameKana: string | null;
  birthDate: string | null;
  /** M / F */
  sex: string | null;
  /** カードの国籍・地域の表記(無ければ登録者の国籍コード) */
  nationality: string | null;
  statusOfResidence: string | null;
  expiryDate: string | null;
  cardValidUntil: string | null;
  outsideActivity: string | null;
  outsideActivityUntil: string | null;
  /** 伏せた在留カード番号(全桁は監査ログに残る別の操作で出す) */
  cardNumberMasked: string | null;
  site: { officialName: string | null; name: string; address: string | null; phone: string | null; insuranceOfficeNumber: string | null };
  employer: { name: string | null; address: string | null; phone: string | null; representativeName: string | null };
}

export interface NoticeField {
  label: string;
  value: string | null;
  /** 番号の全桁など、別の操作で出す値 */
  secret?: boolean;
  /** 空でもよい欄 */
  optional?: boolean;
}

/** 様式第3号の欄の順に並べる(雇用保険の届出の外国人の欄も同じ値を使う) */
export function noticeFields(s: NoticeSource, today: string): NoticeField[] {
  const permit = outsidePermission({ outsideActivity: s.outsideActivity, outsideActivityUntil: s.outsideActivityUntil }, s.eventDate || today);
  const permanent = !s.expiryDate && /永住/.test(s.statusOfResidence ?? "");
  return [
    { label: "外国人の氏名(ローマ字)", value: s.name },
    { label: "フリガナ", value: s.nameKana },
    { label: "在留資格", value: s.statusOfResidence },
    { label: "在留期間(満了日)", value: s.expiryDate ?? (permanent ? "在留期間の定めなし" : null) },
    { label: "生年月日", value: s.birthDate },
    { label: "性別", value: s.sex === "M" ? "男" : s.sex === "F" ? "女" : null },
    { label: "国籍・地域", value: s.nationality },
    { label: "資格外活動許可の有無", value: s.outsideActivity === null ? null : permit.kind === "none" || permit.expired ? "無" : "有" },
    { label: "在留カード番号", value: s.cardNumberMasked, secret: true },
    { label: s.kind === "hire" ? "雇入れ年月日" : "離職年月日", value: s.eventDate },
    { label: "事業所の名称", value: s.site.officialName ?? s.site.name },
    { label: "事業所の所在地", value: s.site.address },
    { label: "事業所の電話番号", value: s.site.phone },
    { label: "雇用保険適用事業所番号", value: s.site.insuranceOfficeNumber, optional: true },
    { label: "事業主(法人)の名称", value: s.employer.name },
    { label: "主たる事務所の所在地", value: s.employer.address },
    { label: "主たる事務所の電話番号", value: s.employer.phone },
    { label: "事業主の氏名(代表者)", value: s.employer.representativeName },
  ].map((f) => ({ ...f, value: f.value?.trim() ? f.value.trim() : null }));
}

export const noticeRecordInput = z
  .object({
    personId: z.uuid(),
    kind: z.enum(NOTICE_KINDS),
    eventDate: dateString,
    status: z.enum(["submitted", "not_required"]),
    submittedOn: dateString.nullish(),
    method: z.enum(NOTICE_METHODS).nullish(),
    receiptNo: z.string().trim().max(50).nullish(),
    note: z.string().trim().max(200).nullish(),
  })
  .refine((v) => v.status !== "submitted" || !!v.submittedOn, { message: "提出日を入力してください", path: ["submittedOn"] })
  .refine((v) => v.status !== "not_required" || !!v.note, { message: "届出が不要な理由を入力してください", path: ["note"] });
