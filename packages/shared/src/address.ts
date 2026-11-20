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

/** 項目名・日付・余分な空白を除く */
export function cleanAddress(s: string): string {
  return s
    .replace(/[\u3000\s]+/g, " ")
    .replace(/住居地|ADDRESS|住所/gi, "")
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

/** 都道府県名で始まらない続きの行か(番地・建物名など) */
function isContinuation(line: string): boolean {
  const s = cleanAddress(line);
  return s.length > 0 && s.length <= 40 && !PREF_RE.test(s) && /[0-9０-９丁目番号号室階棟ー\-－]/.test(s) && !/在留資格|STATUS|就労|期間|年月日|許可/.test(s);
}

export interface OcrLine {
  text: string;
  /** 画像上の上端(大きいほど下) */
  top?: number | undefined;
}

/** 表面の OCR から住居地を取り出す(住居地の欄は 1 か所だけ) */
export function addressFromFrontOcr(lines: readonly OcrLine[]): string | null {
  const sorted = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    const a = addressPart(sorted[i]!.text);
    if (!a) continue;
    const next = sorted[i + 1];
    return next && isContinuation(next.text) ? `${a} ${cleanAddress(next.text)}` : a;
  }
  return null;
}

/**
 * 裏面の OCR から最新の住居地を取り出す。住居地記載欄は上から順に追記されるので、いちばん下の記載を最新とする。
 * 行頭の届出年月日(2025年4月1日 など)は除く
 */
export function latestAddressFromBackOcr(lines: readonly OcrLine[]): string | null {
  const sorted = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  let latest: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const text = sorted[i]!.text.replace(/^\s*\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?/, "");
    const a = addressPart(text);
    if (!a) continue;
    const next = sorted[i + 1];
    latest = next && isContinuation(next.text) ? `${a} ${cleanAddress(next.text)}` : a;
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

  const natLine = sorted.find((t) => /国籍|NATIONALITY/i.test(t));
  let nationality = natLine ? valueOf(natLine.slice(natLine.search(/国籍|NATIONALITY/i))) : "";
  if (!nationality) nationality = valueOf(near(/国籍|NATIONALITY/i)[1] ?? "");

  const statusLines = near(/在留資格|STATUS/i);
  let status = statusLines[0] ? valueOf(statusLines[0].slice(statusLines[0].search(/在留資格|STATUS/i))) : "";
  if (!status) status = valueOf(statusLines[1] ?? "");

  return {
    birthDate: firstDate(near(/生年月日|DATE OF BIRTH/i)),
    sex,
    nationality: nationality && nationality.length <= 30 && !/\d/.test(nationality) ? nationality : null,
    statusOfResidence: status && status.length <= 30 ? status.replace(/\s/g, "") : null,
    expiryDate: firstDate(near(/在留期間|満了日|EXPIRATION/i)),
    cardValidUntil: firstDate(sorted.filter((t) => /まで有効|有効/.test(t))),
    address: addressFromFrontOcr(lines),
  };
}
