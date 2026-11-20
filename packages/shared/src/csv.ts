/**
 * CSV の読み書き(RFC 4180)。取込(1-10)と出力(1-14)で使う。
 * 文字コードの判定は呼び出し側(Web は UTF-8 → Shift_JIS の順に試す)
 */

/** CSV を行と列に分ける。先頭の BOM と、末尾の空行は無視する */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r" && s[i + 1] === "\n") i++;
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/**
 * 表計算ソフトで開いたときに式として実行されないよう、先頭が = + - @ タブ 改行 の値には ' を付ける(CSV インジェクション対策)
 */
function neutralize(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function quote(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV の文字列を作る(改行は CRLF。Excel で文字化けしないよう先頭に BOM を付ける) */
export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return (
    "﻿" +
    rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : quote(neutralize(String(v))))).join(",")).join("\r\n") +
    "\r\n"
  );
}
