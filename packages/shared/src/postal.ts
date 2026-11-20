/**
 * 住所から郵便番号を引く(日本郵便の郵便番号データ KEN_ALL を使う。住所を外部に送らない)。
 *
 * KEN_ALL(utf_ken_all.csv)の列: 1 団体コード, 2 旧郵便番号, 3 郵便番号, 4-6 カナ, 7 都道府県, 8 市区町村, 9 町域, 10-15 フラグ
 * 町域名のくせ:
 * - 「以下に掲載がない場合」「○○の次に番地がくる場合」「○○一円」は市区町村全体の番号(町域は空として扱う)
 * - 「（１階）」「（地階・階層不明）」など高層ビルの階ごとの番号は使わない(住所だけでは決まらない)
 * - 「大通西（１～１９丁目）」のようなかっこ書きは除いて町域名で照合する
 * - 長い町域名は複数行に分かれる(かっこが閉じるまで同じ番号の行をつなぐ)
 */
import { parseCsv } from "./csv.js";

export interface PostalRow {
  code: string;
  pref: string;
  city: string;
  /** 表示用の町域名(かっこ書きを除く。市区町村全体の番号は空) */
  town: string;
  /** 照合用 */
  townKey: string;
}

const toHalfDigits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 照合用に住所・町域名をそろえる(空白を除く、ヶ・ｹ をケに、全角数字を半角に) */
export function postalKey(s: string): string {
  return toHalfDigits(s).replace(/[\s\u3000]/g, "").replace(/[ヶｹ]/g, "ケ");
}

/** KEN_ALL の CSV(UTF-8)を照合用の行にする */
export function parseKenAll(csvText: string): PostalRow[] {
  const out: PostalRow[] = [];
  let pending: string[] | null = null;
  for (const cols of parseCsv(csvText)) {
    if (cols.length < 9) continue;
    // 複数行に分かれた町域名をつなぐ(かっこが閉じるまで)
    if (pending && pending[2] === cols[2] && pending[8]!.includes("（") && !pending[8]!.includes("）")) {
      pending[8] += cols[8]!;
      if (!pending[8]!.includes("）")) continue;
      cols.splice(0, cols.length, ...pending);
      pending = null;
    } else if (cols[8]!.includes("（") && !cols[8]!.includes("）")) {
      pending = [...cols];
      continue;
    }
    const row = toRow(cols);
    if (row) out.push(row);
  }
  return out;
}

function toRow(cols: string[]): PostalRow | null {
  const code = cols[2]!.trim();
  const pref = cols[6]!.trim();
  const city = cols[7]!.trim();
  let town = cols[8]!.trim();
  if (!/^\d{7}$/.test(code) || !pref || !city) return null;
  const paren = /（(.*)）/.exec(town);
  // 高層ビルの階ごとの番号は使わない
  if (paren && /階/.test(paren[1]!)) return null;
  if (town === "以下に掲載がない場合" || /の次に番地がくる場合$/.test(town) || /一円$/.test(town)) town = "";
  town = town.replace(/（.*）/, "").trim();
  return { code, pref, city, town, townKey: postalKey(town) };
}

const PREF_RE =
  /^(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/;

/** 住所の先頭の都道府県と残り */
export function splitPrefecture(address: string): { pref: string | null; rest: string } {
  const a = postalKey(address);
  const m = PREF_RE.exec(a);
  return m ? { pref: m[1]!, rest: a.slice(m[1]!.length) } : { pref: null, rest: a };
}

export interface PostalMatch {
  /** 1 つに決まったときの郵便番号(7 桁) */
  postalCode: string | null;
  /** town: 町域まで一致 / city: 市区町村まで(町域が見つからず市区町村全体の番号) */
  level: "town" | "city" | null;
  /** 決まらないときの候補(最大 10) */
  candidates: { code: string; label: string }[];
}

/**
 * 都道府県・市区町村が一致した行(rows)から郵便番号を決める。
 * rest は市区町村名より後ろ(照合用にそろえたもの)
 */
export function matchTown(rows: readonly PostalRow[], rest: string): PostalMatch {
  // 町域名が住所の先頭に一致するもののうち、いちばん長いもの
  const hits = rows.filter((r) => r.townKey && rest.startsWith(r.townKey));
  const maxLen = Math.max(0, ...hits.map((r) => r.townKey.length));
  const best = hits.filter((r) => r.townKey.length === maxLen);
  const label = (r: PostalRow) => `${r.pref}${r.city}${r.town}`;
  const uniq = (rs: readonly PostalRow[]) => [...new Map(rs.map((r) => [r.code, { code: r.code, label: label(r) }])).values()].slice(0, 10);
  if (best.length > 0) {
    const c = uniq(best);
    return c.length === 1 ? { postalCode: c[0]!.code, level: "town", candidates: c } : { postalCode: null, level: "town", candidates: c };
  }
  const whole = rows.filter((r) => !r.townKey);
  const c = uniq(whole);
  if (c.length === 1) return { postalCode: c[0]!.code, level: "city", candidates: c };
  return { postalCode: null, level: null, candidates: uniq(rows) };
}

/** 7 桁 → 123-4567 */
export const formatPostalCode = (code: string | null | undefined) => (code && /^\d{7}$/.test(code) ? `${code.slice(0, 3)}-${code.slice(3)}` : (code ?? ""));

/** 入力の郵便番号(〒・ハイフン・全角を許す)を 7 桁に。不正なら null */
export function normalizePostalCode(s: string): string | null {
  const d = toHalfDigits(s).replace(/[〒\s\-ー－]/g, "");
  return /^\d{7}$/.test(d) ? d : null;
}
