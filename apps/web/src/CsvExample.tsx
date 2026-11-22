/** CSV 取込の画面に出す入力例(見出し・記入例・各列の説明)。ひな形のダウンロードとは別に、画面で書き方を確かめられるようにする */
export interface CsvExampleColumn {
  header: string;
  required?: boolean;
  note: string;
}

export function CsvExample({ columns, rows, notes }: { columns: readonly CsvExampleColumn[]; rows: readonly (readonly string[])[]; notes?: readonly string[] }) {
  return (
    <details className="csv-example" open>
      <summary>入力例</summary>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.header}>
                  {c.header}
                  {c.required && <span className="b-expired">(必須)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c, j) => (
                  <td key={c.header}>{r[j] ? <code>{r[j]}</code> : <span className="sub">(空欄)</span>}</td>
                ))}
              </tr>
            ))}
            <tr>
              {columns.map((c) => (
                <td key={c.header} className="sub">
                  {c.note}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="sub">CSV ファイルでは 1 行目が見出し、2 行目から各行が 1 件です(例: 「{rows[0]?.join(",")}」)。</p>
      {notes && (
        <ul className="sub">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
