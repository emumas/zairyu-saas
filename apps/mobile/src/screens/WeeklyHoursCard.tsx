/** 登録者の画面: 週28時間の確認の要約(勤怠の取り込みと長期休業期間の登録は Web で行う) */
import { formatMinutes, WEEKLY_STATUS_LABEL } from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { api } from "../api";
import { Card, color } from "../ui/kit";

type Data = Awaited<ReturnType<typeof api.workHours.person.query>>;
const TONE = { over: color.danger, near: color.warn, ok: color.ok, noData: color.sub } as const;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export function WeeklyHoursCard({ personId }: { personId: string }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    api.workHours.person
      .query({ personId })
      .then(setData)
      .catch(() => setData(null));
  }, [personId]);
  if (!data || (!data.target && data.days.length === 0)) return null;
  const c = data.check;
  return (
    <Card>
      <Text style={{ fontWeight: "700" }}>
        週28時間の確認({md(data.from)}〜{md(data.to)})
      </Text>
      <Text style={{ fontSize: 18, fontWeight: "700", color: TONE[c.status] }}>{WEEKLY_STATUS_LABEL[c.status]}</Text>
      {c.maxWindow && (
        <Text>
          連続 7 日の最大: {formatMinutes(c.maxWindow.minutes)}({md(c.maxWindow.from)}〜{md(c.maxWindow.to)})
        </Text>
      )}
      {c.breakDaysOver.length > 0 && <Text style={{ color: color.danger }}>長期休業期間に 1 日 8 時間を超えた日が {c.breakDaysOver.length} 日あります</Text>}
      {data.breaks.map((b) => (
        <Text key={b.id} style={{ color: color.sub }}>
          長期休業期間: {b.fromDate} 〜 {b.toDate}
        </Text>
      ))}
      <Text style={{ color: color.sub, fontSize: 11, marginTop: 4 }}>
        {data.target ? "" : "今のカードは包括許可ではないため参考表示です。"}他の勤務先の時間も含まれます。勤怠の取り込みと詳細は Web の「週28時間」で行います。
      </Text>
    </Card>
  );
}
