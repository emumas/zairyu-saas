/**
 * 従業員マスタの CSV 一括取込(1-10)。
 * - 1 行目は見出し。列の順番は問わない(見出し名で判断)
 * - 社員番号が既にあれば更新、無ければ新規登録。空欄の任意項目は変更しない
 * - カード情報は取り込まない(アプリで IC を読んで登録する)
 */
import { z } from "zod";
import { isValidDate } from "./jst.js";
import { employeeCodeSchema, nameKanaSchema, nationalitySchema, personNameSchema, phoneSchema } from "./persons.js";

export const MAX_IMPORT_ROWS = 2000;

export const PERSON_IMPORT_COLUMNS = [
  { key: "employeeCode", header: "社員番号", required: true },
  { key: "name", header: "氏名", required: true },
  { key: "nameKana", header: "フリガナ", required: false },
  { key: "siteName", header: "拠点", required: true },
  { key: "nationality", header: "国籍", required: false },
  { key: "birthDate", header: "生年月日", required: false },
  { key: "phone", header: "電話番号", required: false },
  { key: "hiredAt", header: "入社日", required: false },
] as const;
type ColumnKey = (typeof PERSON_IMPORT_COLUMNS)[number]["key"];

/** 見出しの別名(表記ゆれ) */
const ALIASES: Record<string, ColumnKey> = {
  社員番号: "employeeCode",
  従業員番号: "employeeCode",
  社員コード: "employeeCode",
  氏名: "name",
  名前: "name",
  拠点: "siteName",
  拠点名: "siteName",
  事業所: "siteName",
  国籍: "nationality",
  "国籍・地域": "nationality",
  生年月日: "birthDate",
  フリガナ: "nameKana",
  ふりがな: "nameKana",
  カナ: "nameKana",
  氏名カナ: "nameKana",
  電話番号: "phone",
  電話: "phone",
  携帯電話: "phone",
  入社日: "hiredAt",
  入社年月日: "hiredAt",
  雇入れ日: "hiredAt",
};

export const personImportRow = z.object({
  /** CSV の行番号(見出しが 1 行目) */
  line: z.number().int().min(2),
  employeeCode: z.string().max(200),
  name: z.string().max(400),
  siteName: z.string().max(200),
  nationality: z.string().max(50),
  birthDate: z.string().max(50),
  nameKana: z.string().max(400).default(""),
  phone: z.string().max(50).default(""),
  hiredAt: z.string().max(50).default(""),
});
export type PersonImportRow = z.infer<typeof personImportRow>;

export const personImportInput = z.object({ rows: z.array(personImportRow).min(1).max(MAX_IMPORT_ROWS) });

export const IMPORT_FIELD_LABEL: Record<"siteId" | "employeeCode" | "name" | "nameKana" | "phone" | "nationality" | "birthDate" | "hiredAt", string> = {
  hiredAt: "入社日",
  siteId: "拠点",
  employeeCode: "社員番号",
  name: "氏名",
  nameKana: "フリガナ",
  phone: "電話番号",
  nationality: "国籍",
  birthDate: "生年月日",
};

/** 1990/1/2・1990-01-02・1990年1月2日 を YYYY-MM-DD にする。読めなければ null */
export function normalizeDateInput(s: string): string | null {
  const m = /^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/.exec(s.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return isValidDate(d) ? d : null;
}

/** CSV の行を取込用の行にする。見出しが足りなければ error */
export function rowsFromCsv(table: string[][]): { rows: PersonImportRow[] } | { error: string } {
  const [header, ...body] = table;
  if (!header) return { error: "CSV が空です" };
  const index = new Map<ColumnKey, number>();
  header.forEach((h, i) => {
    const key = ALIASES[h.trim().replace(/^\uFEFF/, "")];
    if (key && !index.has(key)) index.set(key, i);
  });
  const missing = PERSON_IMPORT_COLUMNS.filter((c) => c.required && !index.has(c.key)).map((c) => c.header);
  if (missing.length > 0) return { error: `見出しに ${missing.join("・")} の列がありません(1 行目は見出しにしてください)` };
  const rows: PersonImportRow[] = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    const get = (k: ColumnKey) => {
      const idx = index.get(k);
      return idx === undefined ? "" : (cells[idx] ?? "").trim();
    };
    rows.push({
      line: i + 2,
      employeeCode: get("employeeCode"),
      name: get("name"),
      siteName: get("siteName"),
      nationality: get("nationality"),
      birthDate: get("birthDate"),
      nameKana: get("nameKana"),
      phone: get("phone"),
      hiredAt: get("hiredAt"),
    });
  });
  if (rows.length === 0) return { error: "取り込む行がありません" };
  if (rows.length > MAX_IMPORT_ROWS) return { error: `一度に取り込めるのは ${MAX_IMPORT_ROWS} 行までです(${rows.length} 行あります)` };
  return { rows };
}

export interface NormalizedImportRow {
  employeeCode: string;
  name: string;
  siteName: string;
  nationality: string | null;
  birthDate: string | null;
  nameKana: string | null;
  phone: string | null;
  hiredAt: string | null;
}

/** 1 行の値を確かめる(拠点の有無や重複はサーバーで確かめる) */
export function validateImportRow(r: z.input<typeof personImportRow>): { value: NormalizedImportRow } | { errors: string[] } {
  const errors: string[] = [];
  const issue = (res: { success: boolean; error?: { issues: { message: string }[] } }) => {
    if (!res.success) errors.push(res.error!.issues[0]!.message);
  };
  const code = employeeCodeSchema.safeParse(r.employeeCode);
  issue(code);
  const name = personNameSchema.safeParse(r.name.replace(/\s+/g, " "));
  issue(name);
  if (r.siteName === "") errors.push("拠点を入力してください");
  let nationality: string | null = null;
  if (r.nationality !== "") {
    const n = nationalitySchema.safeParse(r.nationality.toUpperCase());
    issue(n);
    if (n.success) nationality = n.data;
  }
  let birthDate: string | null = null;
  if (r.birthDate !== "") {
    birthDate = normalizeDateInput(r.birthDate);
    if (!birthDate) errors.push("生年月日は 1990/01/31 または 1990-01-31 の形で入力してください");
  }
  let hiredAt: string | null = null;
  if ((r.hiredAt ?? "") !== "") {
    hiredAt = normalizeDateInput(r.hiredAt!);
    if (!hiredAt) errors.push("入社日は 2024/04/01 または 2024-04-01 の形で入力してください");
  }
  const kana = nameKanaSchema.safeParse(r.nameKana ?? "");
  issue(kana);
  const phone = phoneSchema.safeParse(r.phone ?? "");
  issue(phone);
  if (errors.length > 0 || !code.success || !name.success || !kana.success || !phone.success) return { errors };
  return { value: { employeeCode: code.data, name: name.data, siteName: r.siteName, nationality, birthDate, nameKana: kana.data, phone: phone.data, hiredAt } };
}

/** 取込用 CSV のひな形(見出しと記入例) */
export function personImportTemplate(): string[][] {
  return [PERSON_IMPORT_COLUMNS.map((c) => c.header), ["E0001", "NGUYEN VAN A", "グエン ヴァン アー", "本社", "VNM", "1995-04-01", "090-1234-5678", "2024-04-01"]];
}
