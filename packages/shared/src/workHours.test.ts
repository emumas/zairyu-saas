import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { checkWeeklyHours, formatMinutes, parseDurationMinutes, workedMinutes, workRowsFromCsv } from "./workHours.js";

describe("時間の読み取り", () => {
  it.each([
    ["6:30", 390],
    ["6.5", 390],
    ["6.25", 375],
    ["8", 480],
    ["390分", 390],
    ["6時間30分", 390],
    ["6時間", 360],
    ["6h30m", 390],
    ["６：３０", 390],
    ["6:75", null],
    ["abc", null],
  ])("%s → %s", (s, m) => expect(parseDurationMinutes(s)).toBe(m));

  it("出勤・退勤・休憩。日をまたぐ勤務", () => {
    expect(workedMinutes("9:00", "17:30", "60")).toBe(450);
    expect(workedMinutes("9:00", "17:30", "1:00")).toBe(450);
    expect(workedMinutes("22:00", "5:00", "")).toBe(420);
    expect(workedMinutes("9:00", "10:00", "120")).toBeNull();
    expect(workedMinutes("9時", "17:00", "")).toBeNull();
  });
  it("表示", () => expect(formatMinutes(1710)).toBe("28時間30分"));
});

describe("勤怠 CSV", () => {
  it("労働時間の列でも、出勤・退勤・休憩の列でも読める。誤りは行ごとに返す", () => {
    const a = workRowsFromCsv(parseCsv("社員番号,日付,労働時間\nE1,2026/4/1,6:30\nE1,2026-04-02,\nE2,2026-13-01,5\n"));
    expect(a).toMatchObject({
      rows: [
        { line: 2, employeeCode: "E1", date: "2026-04-01", minutes: 390, errors: [] },
        { line: 3, minutes: 0, errors: [] },
        { line: 4, errors: [expect.stringContaining("日付")] },
      ],
    });
    const b = workRowsFromCsv(parseCsv("従業員番号,勤務日,出勤時刻,退勤時刻,休憩時間\nE1,2026-04-01,9:00,17:00,45\n"));
    expect(b).toMatchObject({ rows: [{ minutes: 435 }] });
    expect(workRowsFromCsv(parseCsv("社員番号,日付\nE1,2026-04-01\n"))).toEqual({ error: expect.stringContaining("労働時間") });
  });
});

describe("週28時間(どの曜日から起算しても)", () => {
  const period = { from: "2026-04-01", to: "2026-04-30" };
  const days = (start: string, hours: number[]) =>
    hours.map((h, i) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), minutes: h * 60 }));

  it("月〜日の区切りでは 28 時間以内でも、ずらした 7 日で超えれば超過", () => {
    // 4/6(月)〜4/12(日)は 4 時間 × 7 = 28 時間、4/13(月)〜は 4/13・4/14 に 8 時間ずつ
    const d = [...days("2026-04-06", [4, 4, 4, 4, 4, 4, 4]), ...days("2026-04-13", [8, 8])];
    const r = checkWeeklyHours(d, [], period);
    expect(r.status).toBe("over");
    expect(r.maxWindow).toEqual({ from: "2026-04-08", to: "2026-04-14", minutes: 36 * 60 });
  });

  it("24 時間以上は注意、それ未満は問題なし、データが無ければなし", () => {
    expect(checkWeeklyHours(days("2026-04-06", [4, 4, 4, 4, 4, 4, 0]), [], period).status).toBe("near");
    expect(checkWeeklyHours(days("2026-04-06", [3, 3, 3, 3, 3, 3, 3]), [], period).status).toBe("ok");
    expect(checkWeeklyHours([], [], period).status).toBe("noData");
    // ちょうど 28 時間は超過ではない
    expect(checkWeeklyHours(days("2026-04-06", [4, 4, 4, 4, 4, 4, 4]), [], period).status).toBe("near");
  });

  it("長期休業期間は 1 日 8 時間まで(その期間を含む 7 日は 28 時間の確認から外す)", () => {
    const vacation = [{ fromDate: "2026-04-10", toDate: "2026-04-20" }];
    expect(checkWeeklyHours(days("2026-04-10", [8, 8, 8, 8, 8, 8, 8]), vacation, period).status).toBe("ok");
    const over = checkWeeklyHours(days("2026-04-10", [9]), vacation, period);
    expect(over).toMatchObject({ status: "over", breakDaysOver: [{ date: "2026-04-10", minutes: 540 }] });
  });
});
