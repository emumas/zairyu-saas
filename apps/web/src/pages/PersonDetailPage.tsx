import {
  ADDRESS_SOURCE_LABEL,
  EXPIRY_BUCKET_LABEL,
  formatPostalCode,
  WORK_RESTRICTION_LABEL,
} from "@zairyu/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, messageOf } from "../api";
import { CardFaceView, type ImageData } from "../CardFaceView";
import { FORMAT_LABEL, METHOD_LABEL, RESULT_LABEL } from "../labels";
import { useSession } from "../session";
import { EmploymentSection } from "./EmploymentSection";
import { CardDetailsForm, PersonEditForm } from "./personForms";
import { Button, Card, fmtDateTime, Message } from "../ui";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;
type Cards = Awaited<ReturnType<typeof api.cards.listForPerson.query>>;

const IMAGE: Record<string, string> = {
  front: "撮影した表面",
  back: "撮影した裏面",
  ic_front: "IC の券面イメージ",
  ic_face: "IC の顔写真",
  ic_name: "IC の氏名イメージ",
  ic_address: "IC の住居地イメージ",
};

export function PersonDetailPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const [p, setP] = useState<Person | null>(null);
  const [cards, setCards] = useState<Cards>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<"person" | "card" | null>(null);
  const reload = () => {
    setEditing(null);
    setReloadKey((k) => k + 1);
  };
  /** カードごとの組み立て表示(画像はメモリ上だけに持ち、ブラウザのキャッシュに残さない) */
  const [faces, setFaces] = useState<
    Record<string, { front: ImageData; face: ImageData | null }>
  >({});
  const [loadingFace, setLoadingFace] = useState<string | null>(null);
  /** 全桁表示した番号(この画面を開いている間だけ。表示は監査ログに残る) */
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function reveal(cardId: string) {
    try {
      const r = await api.cards.revealCardNumber.mutate({ cardId });
      setRevealed((x) => ({ ...x, [cardId]: r.cardNumber }));
    } catch (e) {
      setError(messageOf(e));
    }
  }

  useEffect(() => {
    api.persons.get.query({ id }).then(setP, (e) => setError(messageOf(e)));
    if (session.can("verifications.read"))
      api.cards.listForPerson
        .query({ personId: id })
        .then(setCards, (e) => setError(messageOf(e)));
  }, [id, session, reloadKey]);

  /** 画像は 2 分で切れる URL を新しいタブで開く(閲覧は監査ログに記録される) */
  async function openImage(imageId: string) {
    try {
      const { url } = await api.cards.getImageUrl.mutate({ imageId });
      window.open(new URL(url).pathname, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** IC の券面イメージと顔写真から、カードの見た目で表示する(旧様式。閲覧は監査ログに記録される) */
  async function showCardFace(
    cardId: string,
    frontId: string,
    faceId: string | undefined,
  ) {
    setLoadingFace(cardId);
    try {
      const [front, face] = await Promise.all([
        api.cards.getImage.mutate({ imageId: frontId }),
        faceId
          ? api.cards.getImage.mutate({ imageId: faceId })
          : Promise.resolve(null),
      ]);
      setFaces((f) => ({ ...f, [cardId]: { front, face } }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoadingFace(null);
    }
  }

  if (!p)
    return (
      <Message text={error ?? "読み込み中…"} tone={error ? "danger" : "warn"} />
    );
  return (
    <>
      <p>
        <Link to="/persons">‹ 登録者一覧</Link>
      </p>
      <h1>{p.name}</h1>
      <Message text={error} />
      <div className="grid2">
        <Card
          title="登録者"
          actions={
            session.can("persons.write") &&
            p.status !== "archived" &&
            editing !== "person" ? (
              <Button kind="secondary" onClick={() => setEditing("person")}>
                編集
              </Button>
            ) : null
          }
        >
          {editing === "person" ? (
            <PersonEditForm person={p} onDone={reload} />
          ) : (
            <dl>
              {p.nameKana && (
                <>
                  <dt>フリガナ</dt>
                  <dd>{p.nameKana}</dd>
                </>
              )}
              <dt>社員番号</dt>
              <dd>{p.employeeCode}</dd>
              <dt>拠点</dt>
              <dd>{p.siteName}</dd>
              <dt>状態</dt>
              <dd>
                {
                  {
                    active: "在籍",
                    retired: `退職(${p.retiredAt ?? ""})`,
                    archived: "アーカイブ",
                  }[p.status]
                }
              </dd>
              {p.nationality && (
                <>
                  <dt>国籍・地域</dt>
                  <dd>{p.nationality}</dd>
                </>
              )}
              {p.birthDate && (
                <>
                  <dt>生年月日</dt>
                  <dd>{p.birthDate}</dd>
                </>
              )}
              {p.phone && (
                <>
                  <dt>電話番号</dt>
                  <dd>{p.phone}</dd>
                </>
              )}
            </dl>
          )}
        </Card>
        <Card title="現在のカード">
          <dl>
            <dt>期限区分</dt>
            <dd className={`b-${p.expiry.bucket}`}>
              {EXPIRY_BUCKET_LABEL[p.expiry.bucket]}
            </dd>
            {p.expiry.deadline && (
              <>
                <dt>
                  {p.expiry.deadlineBasis === "card"
                    ? "カード有効期限"
                    : "在留期間満了日"}
                </dt>
                <dd>
                  {p.expiry.deadline}(残り {p.expiry.daysLeft} 日)
                </dd>
              </>
            )}
            {p.expiry.specialPeriodUntil && (
              <>
                <dt>特例期間</dt>
                <dd>{p.expiry.specialPeriodUntil} まで</dd>
              </>
            )}
            {p.card && (
              <>
                <dt>様式</dt>
                <dd>{FORMAT_LABEL[p.card.cardFormat]}</dd>
                <dt>在留資格</dt>
                <dd>{p.card.statusOfResidence ?? "—"}</dd>
                <dt>就労制限</dt>
                <dd>
                  {p.card.workRestriction
                    ? (WORK_RESTRICTION_LABEL[
                        p.card
                          .workRestriction as keyof typeof WORK_RESTRICTION_LABEL
                      ] ?? p.card.workRestriction)
                    : "—"}
                </dd>
                <dt>IC 検証</dt>
                <dd>{p.card.icVerified ? "検証済み" : "未検証"}</dd>
                {p.card.needsReview && (
                  <>
                    <dt>要確認</dt>
                    <dd className="b-expired">
                      署名検証の失敗または失効(入管局・労働局に相談)
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
        </Card>
      </div>
      <EmploymentSection person={p} onChanged={reload} />
      {(() => {
        const cur = cards.find((c) => c.isCurrent);
        if (!cur) return null;
        return (
          <Card
            title="カード記載事項"
            actions={
              session.can("cards.write") &&
              p.status === "active" &&
              editing !== "card" ? (
                <Button kind="secondary" onClick={() => setEditing("card")}>
                  入力・直す
                </Button>
              ) : null
            }
          >
            {editing === "card" ? (
              <CardDetailsForm card={cur} onDone={reload} />
            ) : (
              <dl>
                <dt>在留カード番号</dt>
                <dd>
                  <code>{revealed[cur.id] ?? cur.cardNumberMasked}</code>{" "}
                  {session.can("cards.viewImage") && !revealed[cur.id] && (
                    <button
                      className="link"
                      onClick={() => void reveal(cur.id)}
                    >
                      全桁を表示(記録が残ります)
                    </button>
                  )}
                </dd>
                <dt>生年月日</dt>
                <dd>{cur.birthDate ?? "—"}</dd>
                <dt>性別</dt>
                <dd>{cur.sex === "M" ? "男" : cur.sex === "F" ? "女" : "—"}</dd>
                <dt>国籍・地域</dt>
                <dd>{cur.nationality ?? "—"}</dd>
                <dt>住居地</dt>
                <dd>
                  {cur.postalCode ? `〒${formatPostalCode(cur.postalCode)} ` : ""}{cur.address ?? "—"}
                  {cur.address && cur.addressSource && (
                    <span className="sub">
                      (
                      {ADDRESS_SOURCE_LABEL[
                        cur.addressSource as keyof typeof ADDRESS_SOURCE_LABEL
                      ] ?? cur.addressSource}
                      {cur.addressWrittenAt
                        ? `・${cur.addressWrittenAt} 記載`
                        : ""}
                      )
                    </span>
                  )}
                </dd>
                <dt>在留資格</dt>
                <dd>{cur.statusOfResidence ?? "—"}</dd>
                {cur.periodOfStay && (
                  <>
                    <dt>在留期間</dt>
                    <dd>{cur.periodOfStay}</dd>
                  </>
                )}
                {cur.permittedAt && (
                  <>
                    <dt>許可年月日</dt>
                    <dd>{cur.permittedAt}</dd>
                  </>
                )}
                <dt>在留期間満了日</dt>
                <dd>{cur.expiryDate ?? "—"}</dd>
                <dt>カードの有効期限</dt>
                <dd>{cur.cardValidUntil ?? "—"}</dd>
              </dl>
            )}
          </Card>
        );
      })()}
      {cards.map((c) => (
        <Card
          key={c.id}
          title={`${FORMAT_LABEL[c.cardFormat]} ・ ${fmtDateTime(c.createdAt)} 登録${c.isCurrent ? "(現在)" : ""}`}
        >
          {faces[c.id] && (
            <CardFaceView front={faces[c.id]!.front} face={faces[c.id]!.face} />
          )}
          {session.can("cards.viewImage") && c.images.length > 0 && (
            <div className="row wrap">
              {c.cardFormat === "legacy" &&
                !faces[c.id] &&
                c.images.some((i) => i.kind === "ic_front") && (
                  <Button
                    busy={loadingFace === c.id}
                    onClick={() =>
                      void showCardFace(
                        c.id,
                        c.images.find((i) => i.kind === "ic_front")!.id,
                        c.images.find((i) => i.kind === "ic_face")?.id,
                      )
                    }
                  >
                    カードの見た目で表示
                  </Button>
                )}
              {c.images.map((img) => (
                <Button
                  key={img.id}
                  kind="secondary"
                  onClick={() => void openImage(img.id)}
                >
                  {IMAGE[img.kind] ?? img.kind}
                </Button>
              ))}
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>確認方法</th>
                <th>結果</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {c.verifications.map((v) => (
                <tr key={v.id}>
                  <td>{fmtDateTime(v.performedAt)}</td>
                  <td>{METHOD_LABEL[v.method] ?? v.method}</td>
                  <td>{RESULT_LABEL[v.result] ?? v.result}</td>
                  <td>{v.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  );
}
