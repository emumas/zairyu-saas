/**
 * 登録者の追加(Web)。入力中に同一人物と思われる登録者を確かめる:
 * - 在籍中の人 → 二重登録の疑い(異動なら既存の登録者の拠点を変更)
 * - 退職した人 → 前回の退職理由を出し、新しく追加せずに再入社にする
 * カードの登録(IC 読み取り)はスマホアプリで行う
 */
import { jstDate, RETIRE_REASON_LABEL } from "@zairyu/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api, messageOf } from "../api";
import { useSession } from "../session";
import { Button, Card, Message } from "../ui";

type Similar = Awaited<ReturnType<typeof api.persons.findSimilar.query>>[number];

export function PersonCreatePage() {
  const navigate = useNavigate();
  const sites = useSession().me?.sites ?? [];
  const [f, setF] = useState({
    siteId: sites.length === 1 ? sites[0]!.id : "",
    employeeCode: "",
    name: "",
    nameKana: "",
    phone: "",
    nationality: "",
    birthDate: "",
    hiredAt: jstDate(Date.now()),
    insured: "",
  });
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (f.name.trim().length < 2) return setSimilar([]);
    const t = setTimeout(() => {
      api.persons.findSimilar
        .query({ name: f.name.trim(), ...(f.nameKana.trim() ? { nameKana: f.nameKana.trim() } : {}), ...(f.birthDate ? { birthDate: f.birthDate } : {}) })
        .then(setSimilar, () => setSimilar([]));
    }, 400);
    return () => clearTimeout(t);
  }, [f.name, f.nameKana, f.birthDate]);

  const blocking = similar.some((p) => p.strong && (p.status === "active" || p.status === "retired"));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.persons.create.mutate({
        siteId: f.siteId,
        employeeCode: f.employeeCode.trim(),
        name: f.name.trim(),
        ...(f.nameKana.trim() ? { nameKana: f.nameKana.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.nationality.trim() ? { nationality: f.nationality.trim().toUpperCase() } : {}),
        ...(f.birthDate ? { birthDate: f.birthDate } : {}),
        ...(f.hiredAt ? { hiredAt: f.hiredAt } : {}),
        ...(f.insured ? { employmentInsured: f.insured === "yes" } : {}),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
      });
      navigate(`/persons/${id}`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function rehire(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.persons.reactivate.mutate({ id, ...(f.hiredAt ? { hiredAt: f.hiredAt } : {}) });
      navigate(`/persons/${id}`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const input = (key: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} {...props} />
    </label>
  );

  return (
    <>
      <p>
        <Link to="/persons">‹ 登録者一覧</Link>
      </p>
      <h1>登録者を追加</h1>
      <div className="grid2">
        <Card title="登録者の情報">
          <form onSubmit={(e) => void save(e)}>
            <label className="field">
              <span>拠点</span>
              <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })} required>
                <option value="">選んでください</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {input("employeeCode", "社員番号", { required: true, maxLength: 50 })}
            {input("name", "氏名(カードの表記どおり)", { required: true, maxLength: 200 })}
            {input("nameKana", "フリガナ(任意。ひらがなでも可)", { maxLength: 200, placeholder: "グエン ヴァン アー" })}
            {input("birthDate", "生年月日(任意)", { type: "date" })}
            {input("nationality", "国籍・地域(任意。英大文字 3 文字)", { maxLength: 3, placeholder: "VNM" })}
            {input("phone", "電話番号(任意)", { type: "tel", maxLength: 30, placeholder: "090-1234-5678" })}
            {input("hiredAt", "入社日(任意)", { type: "date" })}
            <label className="field">
              <span>雇用保険(外国人雇用状況の届出の書式と期限が変わります)</span>
              <select value={f.insured} onChange={(e) => setF({ ...f, insured: e.target.value })}>
                <option value="">未設定</option>
                <option value="yes">加入している(被保険者)</option>
                <option value="no">加入していない(アルバイトなど)</option>
              </select>
            </label>
            {blocking && (
              <label className="check">
                <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />
                別人であることを確かめたので、新しく追加する
              </label>
            )}
            <Message text={error} />
            <div>
              <Button type="submit" busy={busy} disabled={blocking && !confirmDuplicate}>
                追加する
              </Button>
            </div>
            <p className="sub">在留カードの登録(IC の読み取り)は、追加したあとスマホアプリで行います。</p>
          </form>
        </Card>
        <Card title="同一人物の確認">
          {similar.length === 0 ? (
            <p className="sub">氏名・生年月日(またはフリガナ)を入力すると、同じ人がすでに登録されていないかを確かめます。</p>
          ) : (
            <>
              {similar.map((p, i) => (
                <div key={i} className="notice">
                  <strong>
                    {p.name ?? "(担当外の拠点)"} {p.employeeCode}・{p.siteName}・
                    {p.status === "active" ? "在籍中" : p.status === "retired" ? `退職(${p.retiredAt ?? ""})` : "アーカイブ"}
                    {p.strong ? "" : "(氏名だけ一致。参考)"}
                  </strong>
                  {p.status === "active" && <span>二重登録の疑いがあります。異動の場合は、新しく追加せずに既存の登録者の拠点を変更してください。</span>}
                  {p.lastEmployment && (
                    <span>
                      前回の退職: {p.lastEmployment.retiredAt}・{RETIRE_REASON_LABEL[p.lastEmployment.reasonCode]}
                      {p.lastEmployment.reasonNote ? `・${p.lastEmployment.reasonNote}` : ""}
                    </span>
                  )}
                  <div className="row">
                    {p.id && (
                      <Link to={`/persons/${p.id}`} target="_blank" rel="noreferrer">
                        登録者の画面を開く
                      </Link>
                    )}
                    {p.status === "retired" && p.id && (
                      <Button kind="secondary" busy={busy} onClick={() => void rehire(p.id!)}>
                        この方を再入社にする(新しく追加しない)
                      </Button>
                    )}
                  </div>
                  {p.status === "retired" && !p.id && <span className="sub">担当外の拠点の方です。再入社はテナント管理者に依頼してください。</span>}
                </div>
              ))}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
