/**
 * 年末調整などの申告書(扶養控除等申告書・保険料控除申告書など)の入力用に、在籍者の基本情報を CSV で渡す。
 * 住居地は今のカードの記載。出力は監査ログに記録される(件数のみ)
 */
import { toCsv } from "@zairyu/shared";
import { useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { downloadText } from "../download";
import { Button, Card, Message } from "../ui";

type Row = Awaited<ReturnType<typeof api.reports.declarationBasics.mutate>>["rows"][number];

export const DECLARATION_HEADER = ["社員番号", "氏名", "フリガナ", "生年月日", "郵便番号", "住所", "拠点"];
const cells = (r: Row) => [r.employeeCode, r.name, r.nameKana ?? "", r.birthDate ?? "", r.postalCode, r.address ?? "", r.siteName];
const missingOf = (r: Row) => [!r.nameKana && "フリガナ", !r.postalCode && "郵便番号", !r.address && "住所"].filter((x): x is string => !!x);

export function DeclarationExportCard({ siteId, suffix }: { siteId: string; suffix: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState<Row[] | null>(null);

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const { rows } = await api.reports.declarationBasics.mutate(siteId ? { siteId } : {});
      downloadText(`declaration_basics_${suffix}.csv`, toCsv([DECLARATION_HEADER, ...rows.map(cells)]));
      setIncomplete(rows.filter((r) => missingOf(r).length > 0));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="申告書の入力用データ(年末調整など)">
      <p className="sub">
        在籍中の登録者の 社員番号・氏名・フリガナ・生年月日・郵便番号・住所 を CSV で保存します。扶養控除等申告書・保険料控除申告書などの記入や、給与・年末調整ソフトへの取り込みに使えます。
        住所は今の在留カードの住居地です(拠点の選択は上の欄)。期間の指定は使いません。マイナンバーは扱いません。
      </p>
      <Button busy={busy} onClick={() => void exportCsv()}>
        CSV で保存
      </Button>
      <Message text={error} />
      {incomplete && incomplete.length === 0 && <Message text="全員の フリガナ・郵便番号・住所 がそろっています。" tone="ok" />}
      {incomplete && incomplete.length > 0 && (
        <>
          <Message text={`${incomplete.length} 人は空欄の項目があります。登録者の画面で入力してください(住所・郵便番号は「カード記載事項」、フリガナは「登録者」の編集)。`} tone="warn" />
          <table>
            <thead>
              <tr>
                <th>社員番号</th>
                <th>氏名</th>
                <th>空欄の項目</th>
              </tr>
            </thead>
            <tbody>
              {incomplete.slice(0, 200).map((r) => (
                <tr key={r.id}>
                  <td>{r.employeeCode}</td>
                  <td>
                    <Link to={`/persons/${r.id}`}>{r.name}</Link>
                  </td>
                  <td>{missingOf(r).join("・")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
