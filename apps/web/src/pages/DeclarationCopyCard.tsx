/** 登録者の画面: 申告書(年末調整など)に書き写す項目を 1 つずつコピーする */
import { formatPostalCode } from "@zairyu/shared";
import { useState } from "react";
import { Button, Card } from "../ui";

export function DeclarationCopyCard({ name, nameKana, birthDate, postalCode, address }: { name: string; nameKana: string | null; birthDate: string | null; postalCode: string | null; address: string | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const items: [string, string | null][] = [
    ["氏名", name],
    ["フリガナ", nameKana],
    ["生年月日", birthDate],
    ["郵便番号", postalCode ? formatPostalCode(postalCode) : null],
    ["住所", address],
  ];
  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
    } catch {
      setCopied(null);
    }
  }
  return (
    <Card title="申告書の入力用">
      <p className="sub">扶養控除等申告書・保険料控除申告書などに書き写すときに使います。住所は今の在留カードの住居地です。全員分は「履歴の出力」から CSV で保存できます。</p>
      <dl>
        {items.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>
              {value ?? <span className="b-d30">未入力</span>}{" "}
              {value && (
                <Button kind="secondary" onClick={() => void copy(label, value)}>
                  {copied === label ? "コピーしました" : "コピー"}
                </Button>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
