import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv.js";
import { normalizeDateInput, rowsFromCsv, validateImportRow } from "./personImport.js";

describe("parseCsv", () => {
  it("引用符・改行・カンマ・BOM・CRLF を扱う", () => {
    const t = '﻿a,b,c\r\n"x,1","y ""q""","line1\nline2"\r\n,,\r\n\r\n';
    expect(parseCsv(t)).toEqual([
      ["a", "b", "c"],
      ["x,1", 'y "q"', "line1\nline2"],
    ]);
  });
  it("末尾に改行が無くても最後の行を読む", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("空の列を残す", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("toCsv", () => {
  it("BOM・CRLF・引用符を付け、往復で元に戻る", () => {
    const rows = [
      ["名前", "メモ"],
      ["A,B", 'say "hi"'],
      ["改行\nあり", null],
    ];
    const csv = toCsv(rows);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(parseCsv(csv)).toEqual([
      ["名前", "メモ"],
      ["A,B", 'say "hi"'],
      ["改行\nあり", ""],
    ]);
  });
  it("式として実行される値を無害化する", () => {
    expect(parseCsv(toCsv([["=1+1", "+A", "-B", "@SUM(A1)", "ok"]]))).toEqual([["'=1+1", "'+A", "'-B", "'@SUM(A1)", "ok"]]);
  });
});

describe("normalizeDateInput", () => {
  it.each([
    ["1990-01-02", "1990-01-02"],
    ["1990/1/2", "1990-01-02"],
    ["1990年1月2日", "1990-01-02"],
    ["1990.12.31", "1990-12-31"],
    ["1990/2/30", null],
    ["19900102", null],
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDateInput(input)).toBe(expected);
  });
});

describe("rowsFromCsv", () => {
  it("見出し名で列を決め、順番と別名を問わない", () => {
    const r = rowsFromCsv(parseCsv("拠点名,氏名,従業員番号,メモ\n本社,A B,E1,x\n,,,\n大阪,C,E2,\n"));
    expect(r).toEqual({
      rows: [
        { line: 2, employeeCode: "E1", name: "A B", siteName: "本社", nationality: "", birthDate: "" },
        { line: 4, employeeCode: "E2", name: "C", siteName: "大阪", nationality: "", birthDate: "" },
      ],
    });
  });
  it("必須の見出しが無ければエラー", () => {
    expect(rowsFromCsv(parseCsv("社員番号,氏名\nE1,A\n"))).toEqual({ error: expect.stringContaining("拠点") });
  });
  it("データ行が無ければエラー", () => {
    expect(rowsFromCsv(parseCsv("社員番号,氏名,拠点\n"))).toEqual({ error: "取り込む行がありません" });
  });
  it("行数の上限", () => {
    const body = Array.from({ length: 2001 }, (_, i) => `E${i},A,本社`).join("\n");
    expect(rowsFromCsv(parseCsv(`社員番号,氏名,拠点\n${body}`))).toEqual({ error: expect.stringContaining("2000") });
  });
});

describe("validateImportRow", () => {
  const base = { line: 2, employeeCode: "E1", name: "NGUYEN  VAN A", siteName: "本社", nationality: "vnm", birthDate: "1995/4/1" };
  it("正規化する(国籍は大文字、日付は YYYY-MM-DD、氏名の連続空白は 1 つ)", () => {
    expect(validateImportRow(base)).toEqual({ value: { employeeCode: "E1", name: "NGUYEN VAN A", siteName: "本社", nationality: "VNM", birthDate: "1995-04-01" } });
  });
  it("任意項目の空欄は null", () => {
    expect(validateImportRow({ ...base, nationality: "", birthDate: "" })).toMatchObject({ value: { nationality: null, birthDate: null } });
  });
  it("誤りをすべて返す", () => {
    const r = validateImportRow({ ...base, employeeCode: "社員1", name: "", siteName: "", nationality: "VN", birthDate: "1995/13/1" });
    expect("errors" in r && r.errors).toHaveLength(5);
  });
});
