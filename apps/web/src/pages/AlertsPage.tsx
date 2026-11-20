import { ALERT_LABEL, type AlertType } from "@zairyu/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, fmtDateTime, Message } from "../ui";

type Alert = Awaited<ReturnType<typeof api.alerts.list.query>>[number];

export function AlertsPage() {
  const session = useSession();
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.alerts.list.query({ open, limit: 100, offset: 0 }).then(setItems, (e) => setError(messageOf(e))), [open]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>アラート</h1>
      <div className="row">
        <Button kind={open ? "primary" : "secondary"} onClick={() => setOpen(true)}>
          未対応
        </Button>
        <Button kind={!open ? "primary" : "secondary"} onClick={() => setOpen(false)}>
          すべて
        </Button>
      </div>
      <Message text={error} />
      <table>
        <thead>
          <tr>
            <th>種類</th>
            <th>登録者</th>
            <th>拠点</th>
            <th>通知日</th>
            <th>対応</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className={a.type === "expired" || a.type === "needs_review" ? "b-expired" : "b-within30"}>{ALERT_LABEL[a.type as AlertType] ?? a.type}</td>
              <td>
                <Link to={`/persons/${a.person.id}`}>
                  {a.person.name}({a.person.employeeCode})
                </Link>
              </td>
              <td>{a.person.siteName}</td>
              <td>{a.dueDate}</td>
              <td>
                {a.acknowledgedAt ? (
                  `対応済み ${fmtDateTime(a.acknowledgedAt)}`
                ) : session.can("alerts.ack") ? (
                  <Button kind="secondary" onClick={() => api.alerts.acknowledge.mutate({ id: a.id }).then(load, (e) => setError(messageOf(e)))}>
                    対応済みにする
                  </Button>
                ) : (
                  "未対応"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <p className="sub">アラートはありません</p>}
    </>
  );
}
