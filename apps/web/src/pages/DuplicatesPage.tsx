/** 二重登録の疑い: 在籍中で、氏名と生年月日(またはフリガナと生年月日)が同じ登録者の組 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { Card, Message } from "../ui";

type Group = Awaited<ReturnType<typeof api.persons.duplicates.query>>[number];

export function DuplicatesPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.persons.duplicates.query().then(setGroups, (e) => setError(messageOf(e)));
  }, []);
  return (
    <>
      <h1>二重登録の疑い</h1>
      <p className="sub">
        在籍中の登録者のうち、氏名と生年月日(またはフリガナと生年月日)が同じ組です。異動(拠点の変更)なのに新しく登録した場合は、片方を退職かアーカイブにし、残す登録者の拠点を変更してください。別人であれば、そのままで構いません。
      </p>
      <Message text={error} />
      {groups && groups.length === 0 && <Message text="二重登録の疑いはありません" tone="ok" />}
      {groups?.map((g, i) => (
        <Card key={i} title={`組 ${i + 1}`}>
          <table>
            <thead>
              <tr>
                <th>社員番号</th>
                <th>氏名</th>
                <th>拠点</th>
                <th>生年月日</th>
                <th>入社日</th>
              </tr>
            </thead>
            <tbody>
              {g.members.map((m) => (
                <tr key={`${m.employeeCode}-${m.siteName}`}>
                  <td>{m.id ? <Link to={`/persons/${m.id}`}>{m.employeeCode}</Link> : m.employeeCode}</td>
                  <td>{m.name ?? "(担当外の拠点)"}</td>
                  <td>{m.siteName}</td>
                  <td>{m.birthDate ?? "—"}</td>
                  <td>{m.hiredAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  );
}
