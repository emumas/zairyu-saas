/**
 * 従業員マスタの CSV 一括取込(1-10)。読み込み → プレビュー(サーバーで判定)→ 確定。
 * カード情報は取り込まない(アプリで IC を読んで登録する)
 */
import { IMPORT_FIELD_LABEL, parseCsv, personImportTemplate, rowsFromCsv, toCsv, type PersonImportRow } from "@zairyu/shared";
import { useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { downloadText, readCsvFile } from "../download";
import { CsvExample } from "../CsvExample";
import { Button, Card, Message } from "../ui";

type Preview = Awaited<ReturnType<typeof api.imports.previewPersons.mutate>>["rows"];
const EXAMPLE_COLUMNS = [
  { header: "社員番号", required: true, note: "登録済みなら更新、無ければ新規" },
  { header: "氏名", required: true, note: "在留カードの表記(ローマ字は大文字)" },
  { header: "フリガナ", note: "カタカナ(ひらがなも可)" },
  { header: "拠点", required: true, note: "登録済みの拠点名" },
  { header: "国籍", note: "国コード(VNM・PHL など)か国名(ベトナムなど)" },
  { header: "生年月日", note: "1995/04/01 または 1995-04-01" },
  { header: "電話番号", note: "ハイフンあり・なしどちらも可" },
  { header: "入社日", note: "2024/04/01 または 2024-04-01" },
];
const EXAMPLE_ROWS = [
  ["E0001", "NGUYEN VAN A", "グエン ヴァン アー", "本社", "VNM", "1995/04/01", "090-1234-5678", "2024/04/01"],
  ["E0002", "SANTOS MARIA", "サントス マリア", "大阪工場", "PHL", "1998-10-15", "", ""],
];

const ACTION = { create: "新規", update: "更新", unchanged: "変更なし", error: "エラー" } as const;

export function ImportPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<PersonImportRow[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setRows(null);
    setPreview(null);
    setError(null);
    setDone(null);
  }

  async function onFile(file: File | undefined) {
    reset();
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const parsed = rowsFromCsv(parseCsv(await readCsvFile(file)));
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      setRows(parsed.rows);
      setPreview((await api.imports.previewPersons.mutate({ rows: parsed.rows })).rows);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit(skipErrors: boolean) {
    if (!rows) return;
    setBusy(true);
    try {
      const r = await api.imports.commitPersons.mutate({ rows, skipErrors });
      reset();
      setDone(`取り込みました(新規 ${r.created} 件・更新 ${r.updated} 件・変更なし ${r.unchanged} 件${r.skipped ? `・エラーで除外 ${r.skipped} 件` : ""})。`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const count = (a: keyof typeof ACTION) => preview?.filter((p) => p.action === a).length ?? 0;
  const byLine = new Map(rows?.map((r) => [r.line, r]));
  const errors = count("error");
  const changes = count("create") + count("update");

  return (
    <>
      <h1>CSV 取込(従業員マスタ)</h1>
      <Card>
        <p className="sub">
          社員番号・氏名・拠点(必須)、国籍・生年月日(任意)の列がある CSV を読み込みます。社員番号が登録済みなら更新、無ければ新規登録します。
          任意項目の空欄は変更しません。拠点は拠点名で指定します(先に<Link to="/org/sites">拠点</Link>を追加してください)。カード情報はアプリで登録します。
        </p>
        <div className="row wrap">
          <label className="btn btn-primary">
            CSV を選ぶ
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <Button kind="secondary" onClick={() => downloadText("persons_import_template.csv", toCsv(personImportTemplate()))}>
            ひな形をダウンロード
          </Button>
          {fileName && <span className="sub">{fileName}</span>}
        </div>
        <p className="sub">文字コードは UTF-8 と Shift_JIS(Excel で保存した CSV)に対応しています。一度に 2,000 行まで。</p>
        <CsvExample
          columns={EXAMPLE_COLUMNS}
          rows={EXAMPLE_ROWS}
          notes={["任意の列(必須でない列)は空欄でも取り込めます。登録済みの人の空欄の項目は変更しません。", "列の順番は自由です。見出しの名前で列を判断します。", "Excel で作る場合は「CSV(コンマ区切り)」で保存してください。"]}
        />
      </Card>
      <Message text={error} />
      <Message text={done} tone="ok" />
      {busy && <Message text="処理中…" tone="warn" />}
      {preview && (
        <Card
          title={`プレビュー(新規 ${count("create")}・更新 ${count("update")}・変更なし ${count("unchanged")}・エラー ${errors})`}
          actions={
            <div className="row">
              <Button kind="secondary" onClick={reset} disabled={busy}>
                やめる
              </Button>
              {errors === 0 ? (
                <Button onClick={() => void commit(false)} disabled={busy || changes === 0}>
                  取り込む
                </Button>
              ) : (
                <Button onClick={() => void commit(true)} disabled={busy || changes === 0}>
                  エラーの {errors} 行を除いて取り込む
                </Button>
              )}
            </div>
          }
        >
          <table>
            <thead>
              <tr>
                <th>行</th>
                <th>社員番号</th>
                <th>氏名</th>
                <th>拠点</th>
                <th>判定</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {[...preview]
                .sort((a, b) => Number(b.action === "error") - Number(a.action === "error") || a.line - b.line)
                .map((p) => {
                  const r = byLine.get(p.line);
                  return (
                    <tr key={p.line} className={p.action === "unchanged" ? "muted" : ""}>
                      <td>{p.line}</td>
                      <td>{r?.employeeCode}</td>
                      <td>{r?.name}</td>
                      <td>{r?.siteName}</td>
                      <td className={p.action === "error" ? "b-expired" : ""}>{ACTION[p.action]}</td>
                      <td>
                        {p.action === "error"
                          ? p.errors.join(" / ")
                          : p.action === "update"
                            ? `${p.fields.map((f) => IMPORT_FIELD_LABEL[f as keyof typeof IMPORT_FIELD_LABEL] ?? f).join("・")}を変更`
                            : ""}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
