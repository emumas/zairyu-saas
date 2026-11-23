/**
 * 住居地の読み取り(端末内 OCR の結果から住所らしい行を取り出す)。
 * 優先順位(呼び出し側で使う): IC の裏面追記(旧様式・文字情報)> 裏面の撮影画像の最新の記載 > 表面の撮影画像 > 手入力。
 * OCR の全文は保持せず、ここで取り出した住所だけを使う
 */
import { z } from "zod";

export const ADDRESS_SOURCES = ["ic_back", "back_photo", "front_photo", "manual"] as const;
export type AddressSource = (typeof ADDRESS_SOURCES)[number];
export const ADDRESS_SOURCE_LABEL: Record<AddressSource, string> = {
  ic_back: "IC(裏面の記載)",
  back_photo: "裏面の読み取り",
  front_photo: "表面の読み取り",
  manual: "手入力",
};

export const addressInput = z.string().trim().max(200);

const PREFECTURE =
  "(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)";
const PREF_RE = new RegExp(PREFECTURE);

/**
 * 届出年月日などの日付(西暦・和暦。2025年2月14日 / 2025.02.14 / 2025-2-14 / 令和7年2月14日 / R7.2.14)。
 * 裏面は 届出年月日 | 住居地 | 記載者印 の欄が横に並ぶので、OCR が日付を住所と同じ行や次の行にまとめることがある
 */
const DATE_RE = /(?<![A-Za-z0-9])(?:(?:19|20)\d{2}|(?:令和|平成|昭和|[RHS])\s*(?:元|\d{1,2}))\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?/g;

/** 全角の数字・記号を半角に(日付の判定用) */
const toHalfWidth = (s: string) => s.replace(/[０-９．／－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 日付を取り除く */
export function stripDates(s: string): string {
  return toHalfWidth(s).replace(DATE_RE, " ");
}

/** 項目名・日付・余分な空白を除く */
export function cleanAddress(s: string): string {
  return stripDates(s)
    .replace(/[\u3000\s]+/g, " ")
    .replace(/住居地|ADDRESS|住所|届出年月日|記載者印/gi, "")
    .replace(/^[\s:：]+/, "")
    .trim();
}

/** 行から住所の部分(都道府県名から後ろ)を取り出す。無ければ null */
function addressPart(line: string): string | null {
  const m = PREF_RE.exec(line);
  if (!m) return null;
  const s = cleanAddress(line.slice(m.index));
  return s.length >= 5 ? s : null;
}

/** 住所の続きではない欄(ほかの項目・記載者印の印影など)。ここで探すのをやめる */
const OTHER_FIELD_RE = /在留資格|STATUS|就労|期間|年月日|許可|資格外|申請|交付|有効|PERIOD|DATE|NATIONALITY|国籍/i;
/** 読み飛ばす行(項目名だけ・英語の項目名・印影の文字) */
const SKIP_RE = /^(?:[A-Z][A-Z\s()./]*|.*(?:之印|市長|区長|町長|村長|記載者).*)$/;

/**
 * 住所の行(index)の続きの行(番地の残り・建物名・部屋番号)を最大 2 行つなぐ。
 * OCR は項目名(ADDRESS など)や届出年月日を別の行として間に挟むことがあるので、それらは読み飛ばす。
 * 行の高さが分かれば、住所の行から 2.5 行分より下は見ない
 */
function withContinuation(sorted: readonly OcrLine[], index: number, first: string): string {
  const base = sorted[index]!;
  const limit = base.top !== undefined && base.height ? base.top + base.height * 2.5 : undefined;
  const parts = [first];
  for (let j = index + 1; j < sorted.length && j <= index + 4 && parts.length < 3; j++) {
    const line = sorted[j]!;
    if (limit !== undefined && line.top !== undefined && line.top > limit) break;
    const raw = stripDates(line.text).trim();
    if (PREF_RE.test(raw)) break; // 次の記載
    if (OTHER_FIELD_RE.test(raw) && !/[丁目番地号室]/.test(raw)) break;
    const c = cleanAddress(raw);
    if (c.replace(/[\s.,、。・]/g, "").length < 2 || SKIP_RE.test(c)) continue;
    if (c.length > 40) break;
    // 住所の列より左から始まる行は別の欄(位置が分かるときだけ見る)
    if (base.left !== undefined && line.left !== undefined && base.height && line.left < base.left - base.height * 2) continue;
    parts.push(c);
  }
  return parts.join(" ");
}

export interface OcrLine {
  text: string;
  /** 画像上の上端(大きいほど下) */
  top?: number | undefined;
  /** 画像上の左端 */
  left?: number | undefined;
  /** 行の高さ */
  height?: number | undefined;
}

/** 表面の OCR から住居地を取り出す(住居地の欄は 1 か所だけ) */
export function addressFromFrontOcr(lines: readonly OcrLine[]): string | null {
  const sorted = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    const a = addressPart(sorted[i]!.text);
    if (!a) continue;
    return withContinuation(sorted, i, a);
  }
  return null;
}

/**
 * 裏面の OCR から最新の住居地を取り出す。住居地記載欄は上から順に追記されるので、いちばん下の記載を最新とする。
 * 届出年月日(行のどこにあっても、日付だけの行でも)は住所に入れない
 */
export function latestAddressFromBackOcr(lines: readonly OcrLine[]): string | null {
  const sorted = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  let latest: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const a = addressPart(stripDates(sorted[i]!.text));
    if (!a) continue;
    latest = withContinuation(sorted, i, a);
  }
  return latest;
}

/**
 * 採用する住居地を決める。裏面に新しい住所がある場合はそちらを採用する
 * (IC の裏面追記 > 裏面の読み取り > 表面の読み取り)
 */
export function chooseAddress(c: { icBack?: string | null; backPhoto?: string | null; frontPhoto?: string | null }): { address: string; source: AddressSource } | null {
  if (c.icBack?.trim()) return { address: cleanAddress(c.icBack), source: "ic_back" };
  if (c.backPhoto?.trim()) return { address: c.backPhoto.trim(), source: "back_photo" };
  if (c.frontPhoto?.trim()) return { address: c.frontPhoto.trim(), source: "front_photo" };
  return null;
}

// ---------------------------------------------------------------- 表面の記載事項(旧様式は IC に文字情報が無いため)

const toHalfDigits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 「1990年1月2日」→ 1990-01-02(読めなければ null) */
export function japaneseDate(s: string): string | null {
  const m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(toHalfDigits(s));
  if (!m) return null;
  const d = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}

export interface FrontOcrFields {
  birthDate: string | null;
  sex: "M" | "F" | null;
  nationality: string | null;
  statusOfResidence: string | null;
  /** 在留期間(満了日)の日付 */
  expiryDate: string | null;
  /** 「このカードは ○年○月○日まで有効です」 */
  cardValidUntil: string | null;
  address: string | null;
}

const LABELS = /氏名|NAME|生年月日|DATE OF BIRTH|性別|SEX|国籍・地域|国籍|NATIONALITY\/REGION|NATIONALITY|住居地|ADDRESS|在留資格|STATUS|就労制限の有無|在留期間|PERIOD OF STAY|DATE OF EXPIRATION|許可の種類|許可年月日|交付年月日|日本国政府|在留カード|RESIDENCE CARD|番号|No\./gi;

/** 項目名を除いた値の部分 */
const valueOf = (s: string) => s.replace(LABELS, " ").replace(/[()()]/g, " ").replace(/\s+/g, " ").trim();

/**
 * 国籍・地域の欄から国名だけを取り出す。項目名の一部が読み違えられて残ることがある
 * (例:「国籍・地域」→「·地滅」)ので、カタカナ・漢字だけの語のうち最後のもの(項目名の後に書かれる値)を使う
 */
export function countryName(s: string): string | null {
  const words = valueOf(s)
    .split(/[\s·･]+/)
    .map((w) => w.replace(/^[・:：]+|[・:：]+$/g, ""))
    .filter((w) => /^[\p{Script=Katakana}\p{Script=Han}ー・]{2,}$/u.test(w) && !/^(国籍|地域|地.)$/.test(w));
  return words.at(-1) ?? null;
}

/**
 * 旧様式の表面の OCR から記載事項を取り出す(端末で確認・修正してもらう前提の候補)。
 * 項目名の行(と次の行)から値を探す
 */
export function frontFieldsFromOcr(lines: readonly OcrLine[]): FrontOcrFields {
  const sorted = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0)).map((l) => l.text);
  /** 項目名を含む行と、その次の行 */
  const near = (re: RegExp) => {
    const i = sorted.findIndex((t) => re.test(t));
    return i < 0 ? [] : sorted.slice(i, i + 2);
  };
  const firstDate = (cands: string[]) => cands.map(japaneseDate).find((d) => d) ?? null;

  const sexLine = near(/性別|SEX/i).join(" ");
  const sex = /女|\bF\b/.test(sexLine) ? "F" : /男|\bM\b/.test(sexLine) ? "M" : null;

  const natLines = near(/国籍|地域|NATIONALITY|REGION/i);
  let nationality = countryName(natLines[0] ? natLines[0].slice(natLines[0].search(/国籍|地域|NATIONALITY|REGION/i)) : "");
  if (!nationality) nationality = countryName(natLines[1] ?? "");

  const statusLines = near(/在留資格|STATUS/i);
  let status = statusLines[0] ? valueOf(statusLines[0].slice(statusLines[0].search(/在留資格|STATUS/i))) : "";
  if (!status) status = valueOf(statusLines[1] ?? "");

  return {
    birthDate: firstDate(near(/生年月日|DATE OF BIRTH/i)),
    sex,
    nationality: nationality && nationality.length <= 30 ? nationality : null,
    statusOfResidence: status && status.length <= 30 ? status.replace(/\s/g, "") : null,
    expiryDate: firstDate(near(/在留期間|満了日|EXPIRATION/i)),
    cardValidUntil: firstDate(sorted.filter((t) => /まで有効|有効/.test(t))),
    address: addressFromFrontOcr(lines),
  };
}
