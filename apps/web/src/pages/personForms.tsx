/** 登録者詳細の編集フォーム(登録者の情報、カード記載事項の手入力) */
import { useState, type FormEvent } from "react";
import { formatPostalCode } from "@zairyu/shared";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Message } from "../ui";

type Person = Awaited<ReturnType<typeof api.persons.get.query>>;
type CardRow = Awaited<ReturnType<typeof api.cards.listForPerson.query>>[number];

/** 登録者の情報(社員番号・氏名・フリガナ・電話番号・国籍・生年月日・拠点) */
export function PersonEditForm({ person, onDone }: { person: Person; onDone: () => void }) {
  const sites = useSession().me?.sites ?? [];
  const [f, setF] = useState({
    siteId: person.siteId,
    employeeCode: person.employeeCode,
    name: person.name,
    nameKana: person.nameKana ?? "",
    phone: person.phone ?? "",
    nationality: person.nationality ?? "",
    birthDate: person.birthDate ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const patch: Parameters<typeof api.persons.update.mutate>[0] = { id: person.id };
    if (f.siteId !== person.siteId) patch.siteId = f.siteId;
    if (f.employeeCode.trim() !== person.employeeCode) patch.employeeCode = f.employeeCode.trim();
    if (f.name.trim() !== person.name) patch.name = f.name.trim();
    if (f.nameKana.trim() !== (person.nameKana ?? "")) patch.nameKana = f.nameKana.trim();
    if (f.phone.trim() !== (person.phone ?? "")) patch.phone = f.phone.trim();
    if (f.nationality.trim().toUpperCase() !== (person.nationality ?? "")) patch.nationality = f.nationality.trim() ? f.nationality.trim().toUpperCase() : null;
    if (f.birthDate !== (person.birthDate ?? "")) patch.birthDate = f.birthDate || null;
    if (Object.keys(patch).length === 1) return onDone();
    setBusy(true);
    try {
      await api.persons.update.mutate(patch);
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <label className="field">
        <span>拠点</span>
        <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>社員番号</span>
        <input value={f.employeeCode} onChange={(e) => setF({ ...f, employeeCode: e.target.value })} required maxLength={50} />
      </label>
      <label className="field">
        <span>氏名</span>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} />
      </label>
      <label className="field">
        <span>フリガナ(ひらがなでも可)</span>
        <input value={f.nameKana} onChange={(e) => setF({ ...f, nameKana: e.target.value })} placeholder="グエン ヴァン アー" maxLength={200} />
      </label>
      <label className="field">
        <span>電話番号</span>
        <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="090-1234-5678" maxLength={30} />
      </label>
      <label className="field">
        <span>国籍・地域(英大文字 3 文字)</span>
        <input value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value })} placeholder="VNM" maxLength={3} />
      </label>
      <label className="field">
        <span>生年月日</span>
        <input type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
      </label>
      <Message text={error} />
      <div className="row">
        <Button kind="secondary" type="button" onClick={onDone}>
          やめる
        </Button>
        <Button type="submit" busy={busy}>
          保存
        </Button>
      </div>
    </form>
  );
}

/**
 * カード記載事項の手入力(読み取れなかったときなど)。
 * 第2世代の記載事項と、IC の裏面追記から取った住居地は IC の値なので変えられない
 */
export function CardDetailsForm({ card, onDone }: { card: CardRow; onDone: () => void }) {
  const legacy = card.cardFormat === "legacy";
  const addressFromIc = card.addressSource === "ic_back";
  const [f, setF] = useState({
    birthDate: card.birthDate ?? "",
    sex: card.sex ?? "",
    nationality: card.nationality ?? "",
    statusOfResidence: card.statusOfResidence ?? "",
    expiryDate: card.expiryDate ?? "",
    cardValidUntil: card.cardValidUntil ?? "",
    address: card.address ?? "",
    postalCode: card.postalCode ? formatPostalCode(card.postalCode) : "",
  });
  const [postal, setPostal] = useState<{ message: string | null; candidates: { code: string; label: string }[] }>({ message: null, candidates: [] });

  /** 住所から郵便番号を探す(1 つに決まれば入れる。決まらなければ候補を出す) */
  async function findPostal() {
    if (!f.address.trim()) return;
    try {
      const r = await api.postal.lookup.query({ address: f.address.trim() });
      if (!r.loaded) return setPostal({ message: "郵便番号データが未登録です(運用担当者に postal:load の実行を依頼してください)", candidates: [] });
      if (r.postalCode) {
        setF((x) => ({ ...x, postalCode: formatPostalCode(r.postalCode) }));
        return setPostal({ message: r.level === "city" ? "町域が見つからないため、市区町村全体の郵便番号を入れました" : null, candidates: [] });
      }
      setPostal({ message: r.candidates.length ? "候補から選んでください" : "見つかりませんでした。住所を確かめるか、郵便番号を入力してください", candidates: r.candidates });
    } catch (err) {
      setError(messageOf(err));
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const input: Parameters<typeof api.cards.updateDetails.mutate>[0] = { cardId: card.id };
    const v = (s: string) => (s.trim() ? s.trim() : null);
    if (legacy) {
      if (f.birthDate !== (card.birthDate ?? "")) input.birthDate = v(f.birthDate);
      if (f.sex !== (card.sex ?? "")) input.sex = f.sex === "M" || f.sex === "F" ? f.sex : null;
      if (f.nationality !== (card.nationality ?? "")) input.nationality = v(f.nationality);
      if (f.statusOfResidence !== (card.statusOfResidence ?? "")) input.statusOfResidence = v(f.statusOfResidence);
      if (f.expiryDate !== (card.expiryDate ?? "")) input.expiryDate = v(f.expiryDate);
      if (f.cardValidUntil !== (card.cardValidUntil ?? "")) input.cardValidUntil = v(f.cardValidUntil);
    }
    if (!addressFromIc && f.address !== (card.address ?? "")) {
      input.address = v(f.address);
      input.addressSource = "manual";
    }
    if (f.postalCode !== (card.postalCode ? formatPostalCode(card.postalCode) : "")) input.postalCode = f.postalCode.trim() ? f.postalCode : null;
    if (Object.keys(input).length === 1) return onDone();
    setBusy(true);
    try {
      await api.cards.updateDetails.mutate(input);
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      {legacy ? (
        <>
          <label className="field">
            <span>生年月日</span>
            <input type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
          </label>
          <label className="field">
            <span>性別</span>
            <select value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}>
              <option value="">—</option>
              <option value="M">男</option>
              <option value="F">女</option>
            </select>
          </label>
          <label className="field">
            <span>国籍・地域</span>
            <input value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value })} maxLength={50} />
          </label>
          <label className="field">
            <span>在留資格</span>
            <input value={f.statusOfResidence} onChange={(e) => setF({ ...f, statusOfResidence: e.target.value })} maxLength={50} />
          </label>
          <label className="field">
            <span>在留期間の満了日(永住者は空欄)</span>
            <input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
          </label>
          <label className="field">
            <span>カードの有効期限</span>
            <input type="date" value={f.cardValidUntil} onChange={(e) => setF({ ...f, cardValidUntil: e.target.value })} />
          </label>
          <p className="sub">満了日・有効期限を変えると、期限の区分とアラートも変わります。</p>
        </>
      ) : (
        <p className="sub">第2世代のカードの記載事項は IC の値を使っています(変更できません)。</p>
      )}
      {addressFromIc ? (
        <p className="sub">住居地は IC に記録された裏面の記載です。変更は IC の再検証で行います。</p>
      ) : (
        <label className="field">
          <span>住居地</span>
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="東京都新宿区西新宿2-8-1" maxLength={200} />
        </label>
      )}
      <div className="row">
        <label className="field">
          <span>郵便番号(空欄なら住居地から自動で入れます)</span>
          <input value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} placeholder="160-0023" maxLength={10} />
        </label>
        <Button kind="secondary" type="button" onClick={() => void findPostal()} disabled={!f.address.trim()}>
          住所から探す
        </Button>
      </div>
      {postal.message && <p className="sub">{postal.message}</p>}
      {postal.candidates.length > 0 && (
        <div className="row wrap">
          {postal.candidates.map((c) => (
            <Button
              key={c.code}
              kind="secondary"
              type="button"
              onClick={() => {
                setF({ ...f, postalCode: formatPostalCode(c.code) });
                setPostal({ message: null, candidates: [] });
              }}
            >
              〒{formatPostalCode(c.code)} {c.label}
            </Button>
          ))}
        </div>
      )}
      <Message text={error} />
      <div className="row">
        <Button kind="secondary" type="button" onClick={onDone}>
          やめる
        </Button>
        <Button type="submit" busy={busy}>
          保存
        </Button>
      </div>
    </form>
  );
}
