/**
 * 勤怠 CSV と週28時間の確認(フェーズ2)。
 * 資格外活動(包括許可)は「1 週について 28 時間以内(どの曜日から 1 週の起算をした場合でも常に 28 時間以内)」なので、
 * 日ごとの労働時間から、任意の連続 7 日の合計を確かめる。時間はすべて整数(分)で扱う。
 * 学則で定める長期休業期間は 1 日 8 時間以内(この期間を含む 7 日は 28 時間の確認から外し、日ごとに 8 時間を確かめる。簡略化した扱い)
 */
import { addDays, isValidDate } from "./jst.js";
import { z } from "zod";
import { normalizeDateInput } from "./personImport.js";
import { dateString } from "./persons.js";

export const WEEKLY_LIMIT_MINUTES = 28 * 60;
/** これ以上で「注意」 */
export const WEEKLY_NEAR_MINUTES = 24 * 60;
export const BREAK_DAILY_LIMIT_MINUTES = 8 * 60;
export const MAX_WORK_ROWS = 20_000;

const half = (s: string) => s.normalize("NFKC").trim();

/** 「6:30」「6.5」「390分」「6時間30分」「6h30m」を分にする。読めなければ null */
export function parseDurationMinutes(input: string): number | null {
  const s = half(input).replace(/\s/g, "");
  if (s === "") return null;
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
  m = /^(\d{1,4})分$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(?:(\d{1,2})(?:時間|h))?(?:(\d{1,2})(?:分|m))?$/i.exec(s);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  // 時間の小数(6.5 = 6 時間 30 分)。浮動小数点を使わず、整数で分にする
  m = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(s);
  if (m) {
    const frac = m[2] ?? "";
    const scale = 10 ** frac.length;
    return Number(m[1]) * 60 + Math.round((Number(frac || "0") * 60) / scale);
  }
  return null;
}

/** 「9:00」「21:30」を 0 時からの分にする(24:00 を超える書き方も受け付ける) */
export function parseClockMinutes(input: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(half(input));
  if (!m || Number(m[2]) >= 60 || Number(m[1]) > 47) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 出勤・退勤・休憩から労働時間(分)。退勤が出勤より早ければ日をまたいだ勤務とする */
export function workedMinutes(start: string, end: string, breakTime: string): number | null {
  const s = parseClockMinutes(start);
  let e = parseClockMinutes(end);
  if (s === null || e === null) return null;
  if (e <= s) e += 1440;
  const b = breakTime.trim() === "" ? 0 : parseDurationMinutes(/^\d+$/.test(half(breakTime)) ? `${half(breakTime)}分` : breakTime);
  if (b === null || b > e - s) return null;
  return e - s - b;
}

type WorkColumn = "employeeCode" | "date" | "minutes" | "start" | "end" | "break";
const WORK_ALIASES: Record<string, WorkColumn> = {
  社員番号: "employeeCode",
  従業員番号: "employeeCode",
  社員コード: "employeeCode",
  日付: "date",
  勤務日: "date",
  年月日: "date",
  労働時間: "minutes",
  勤務時間: "minutes",
  実働時間: "minutes",
  実労働時間: "minutes",
  出勤: "start",
  出勤時刻: "start",
  始業: "start",
  始業時刻: "start",
  退勤: "end",
  退勤時刻: "end",
  終業: "end",
  終業時刻: "end",
  休憩: "break",
  休憩時間: "break",
};

export interface WorkCsvRow {
  line: number;
  employeeCode: string;
  date: string | null;
  minutes: number | null;
  errors: string[];
}

/** 勤怠 CSV(1 行目は見出し)を行にする。労働時間の列か、出勤・退勤(・休憩)の列が必要 */
export function workRowsFromCsv(table: string[][]): { rows: WorkCsvRow[] } | { error: string } {
  const [header, ...body] = table;
  if (!header) return { error: "CSV が空です" };
  const index = new Map<WorkColumn, number>();
  header.forEach((h, i) => {
    const key = WORK_ALIASES[h.trim().replace(/^\uFEFF/, "")];
    if (key && !index.has(key)) index.set(key, i);
  });
  if (!index.has("employeeCode") || !index.has("date")) return { error: "見出しに 社員番号・日付 の列がありません" };
  if (!index.has("minutes") && !(index.has("start") && index.has("end"))) return { error: "見出しに 労働時間 の列か、出勤・退勤 の列がありません" };
  const rows: WorkCsvRow[] = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    const get = (k: WorkColumn) => {
      const idx = index.get(k);
      return idx === undefined ? "" : (cells[idx] ?? "").trim();
    };
    const errors: string[] = [];
    const employeeCode = get("employeeCode");
    if (!employeeCode) errors.push("社員番号がありません");
    const rawDate = get("date");
    const date = isValidDate(rawDate) ? rawDate : normalizeDateInput(rawDate);
    if (!date) errors.push("日付は 2026/04/01 または 2026-04-01 の形で入力してください");
    let minutes: number | null;
    if (index.has("minutes") && get("minutes") !== "") {
      minutes = parseDurationMinutes(get("minutes"));
      if (minutes === null) errors.push("労働時間は 6:30・6.5・390分 などの形で入力してください");
    } else if (get("start") || get("end")) {
      minutes = workedMinutes(get("start"), get("end"), get("break"));
      if (minutes === null) errors.push("出勤・退勤は 9:00 の形、休憩は分か 1:00 の形で入力してください");
    } else {
      minutes = 0; // 休みの日
    }
    if (minutes !== null && minutes > 1440) errors.push("1 日の労働時間が 24 時間を超えています");
    rows.push({ line: i + 2, employeeCode, date, minutes, errors });
  });
  if (rows.length === 0) return { error: "取り込む行がありません" };
  if (rows.length > MAX_WORK_ROWS) return { error: `一度に取り込めるのは ${MAX_WORK_ROWS} 行までです(${rows.length} 行あります)` };
  return { rows };
}

export type WeeklyStatus = "over" | "near" | "ok" | "noData";
export const WEEKLY_STATUS_LABEL: Record<WeeklyStatus, string> = { over: "28時間超過", near: "注意(24時間以上)", ok: "問題なし", noData: "勤怠データなし" };

export interface WeeklyCheck {
  status: WeeklyStatus;
  /** 合計がいちばん多い連続 7 日 */
  maxWindow: { from: string; to: string; minutes: number } | null;
  /** 28 時間を超えた連続 7 日の始まりの日(重なりを含む) */
  overWindowStarts: string[];
  /** 長期休業期間中に 1 日 8 時間を超えた日 */
  breakDaysOver: { date: string; minutes: number }[];
}

/**
 * 期間 [from, to] に終わる連続 7 日をすべて調べる(from の 6 日前から始まる 7 日も含む)。
 * 長期休業期間の日を含む 7 日は 28 時間の確認から外し、その日は 1 日 8 時間を確かめる
 */
export function checkWeeklyHours(
  days: readonly { date: string; minutes: number }[],
  breaks: readonly { fromDate: string; toDate: string }[],
  period: { from: string; to: string },
): WeeklyCheck {
  const byDate = new Map(days.map((d) => [d.date, d.minutes]));
  const inBreak = (d: string) => breaks.some((b) => b.fromDate <= d && d <= b.toDate);
  const hasData = days.some((d) => d.date >= addDays(period.from, -6) && d.date <= period.to);
  if (!hasData) return { status: "noData", maxWindow: null, overWindowStarts: [], breakDaysOver: [] };

  let maxWindow: WeeklyCheck["maxWindow"] = null;
  const overWindowStarts: string[] = [];
  for (let end = period.from; end <= period.to; end = addDays(end, 1)) {
    const start = addDays(end, -6);
    let sum = 0;
    let excluded = false;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (inBreak(d)) excluded = true;
      sum += byDate.get(d) ?? 0;
    }
    if (excluded) continue;
    if (!maxWindow || sum > maxWindow.minutes) maxWindow = { from: start, to: end, minutes: sum };
    if (sum > WEEKLY_LIMIT_MINUTES) overWindowStarts.push(start);
  }
  const breakDaysOver = days
    .filter((d) => d.date >= period.from && d.date <= period.to && inBreak(d.date) && d.minutes > BREAK_DAILY_LIMIT_MINUTES)
    .map((d) => ({ date: d.date, minutes: d.minutes }));
  const status: WeeklyStatus =
    overWindowStarts.length > 0 || breakDaysOver.length > 0 ? "over" : maxWindow && maxWindow.minutes >= WEEKLY_NEAR_MINUTES ? "near" : "ok";
  return { status, maxWindow, overWindowStarts, breakDaysOver };
}

/** 390 → 「6時間30分」 */
export const formatMinutes = (m: number) => `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;

/** 一度に見られる期間(日) */
export const MAX_WORK_PERIOD_DAYS = 93;

export const workImportInput = z.object({
  rows: z
    .array(
      z.object({
        line: z.number().int().min(1),
        employeeCode: z.string().trim().min(1).max(64),
        date: dateString,
        minutes: z.number().int().min(0).max(1440),
      }),
    )
    .min(1)
    .max(MAX_WORK_ROWS),
  /** true なら保存せず、結果だけ返す */
  dryRun: z.boolean().default(false),
});

export const workPeriodInput = z
  .object({ from: dateString, to: dateString })
  .refine((p) => p.from <= p.to && addDays(p.from, MAX_WORK_PERIOD_DAYS - 1) >= p.to, `期間は ${MAX_WORK_PERIOD_DAYS} 日以内で指定してください`);

export const studyBreakInput = z
  .object({ personId: z.uuid(), fromDate: dateString, toDate: dateString, note: z.string().trim().max(100).nullish() })
  .refine((b) => b.fromDate <= b.toDate, { message: "終了日は開始日以降にしてください", path: ["toDate"] });
