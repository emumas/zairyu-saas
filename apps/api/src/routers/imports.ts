/**
 * 従業員マスタの CSV 一括取込(1-10)。テナント管理者のみ(imports.run)。
 * CSV の読み込み(文字コード・列の対応)は Web で行い、ここでは行ごとの値を受け取る。
 * - preview: 行ごとに 新規 / 更新 / 変更なし / エラー を返す(保存しない)
 * - commit: もう一度同じ判定をして、エラーの無い行を 1 つのトランザクションで保存する
 * 結果に氏名などの値は含めない(呼び出し側が CSV を持っている)。監査ログにも値は残さない
 */
import { createPerson, findPersonsByEmployeeCodes, listEmployments, listSites, personsByBirthDates, updatePerson, type Tx } from "@zairyu/db";
import { personImportInput, personMatchName, RESTRICTED_MESSAGE, RETIRE_REASON_LABEL, validateImportRow, type PersonImportRow, type RetireReason } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { tenantRestriction } from "../billingGuard.js";
import { permissionProcedure, router } from "../trpc.js";

type Field = "siteId" | "name" | "nameKana" | "phone" | "nationality" | "birthDate" | "hiredAt";
type Planned =
  | { line: number; action: "error"; errors: string[] }
  | { line: number; action: "unchanged" }
  | {
      line: number;
      action: "create";
      value: {
        siteId: string;
        employeeCode: string;
        name: string;
        nameKana: string | null;
        phone: string | null;
        nationality: string | null;
        birthDate: string | null;
        hiredAt: string | null;
      };
    }
  | { line: number; action: "update"; id: string; changes: Partial<Record<Field, string>> };

const rowResult = z.object({
  line: z.number(),
  action: z.enum(["create", "update", "unchanged", "error"]),
  /** 更新する項目名(siteId / name / nameKana / phone / nationality / birthDate) */
  fields: z.array(z.string()),
  errors: z.array(z.string()),
});

async function plan(tx: Tx, rows: readonly PersonImportRow[], canCreate: boolean): Promise<Planned[]> {
  // 同一人物の確認の材料(生年月日が同じ既存の登録者と、退職者なら前回の退職理由)
  const validated = rows.map((r) => validateImportRow(r));
  const birthDates = [...new Set(validated.flatMap((v) => ("value" in v && v.value.birthDate ? [v.value.birthDate] : [])))];
  const candidates = await personsByBirthDates(tx, birthDates);
  const lastRetirement = new Map((await listEmployments(tx, candidates.filter((c) => c.status === "retired").map((c) => c.id))).reverse().map((e) => [e.personId, e]));
  const seenIndividuals = new Map<string, number>();
  let currentLine = 0;
  const sameIndividual = (v: { name: string; nameKana: string | null; birthDate: string | null }): string | null => {
    if (!v.birthDate) return null;
    const name = personMatchName(v.name);
    const hit = candidates.find((c) => c.birthDate === v.birthDate && (c.matchName === name || (!!v.nameKana && c.nameKana === v.nameKana)));
    if (hit?.status === "active") {
      return `二重登録の疑い: 同じ氏名・生年月日の在籍者がいます(${hit.siteName} ${hit.employeeCode})。異動なら、その社員番号の行で拠点を変更してください`;
    }
    if (hit?.status === "retired") {
      const e = lastRetirement.get(hit.id);
      const reason = e ? `前回の退職: ${e.retiredAt}・${RETIRE_REASON_LABEL[e.reasonCode as RetireReason] ?? e.reasonCode}${e.reasonNote ? `・${e.reasonNote}` : ""}` : `退職日 ${hit.retiredAt ?? ""}`;
      return `以前在籍していた方と思われます(${hit.siteName} ${hit.employeeCode}、${reason})。再入社は登録者の画面から行ってください`;
    }
    // 同じファイルの中で同じ人を 2 行追加しようとしていないか
    const key = `${name}|${v.birthDate}`;
    const first = seenIndividuals.get(key);
    if (first !== undefined) return `同じ氏名・生年月日の人が ${first} 行目にもあります`;
    seenIndividuals.set(key, currentLine);
    return null;
  };
  const sites = new Map((await listSites(tx)).filter((s) => !s.archivedAt).map((s) => [s.name, s.id]));
  const existing = new Map((await findPersonsByEmployeeCodes(tx, [...new Set(rows.map((r) => r.employeeCode.trim()))])).map((p) => [p.employeeCode, p]));
  const seen = new Map<string, number>();
  return rows.map((r): Planned => {
    currentLine = r.line;
    const v = validateImportRow(r);
    const errors = "errors" in v ? [...v.errors] : [];
    const siteId = sites.get(r.siteName);
    if (r.siteName !== "" && !siteId) errors.push(`拠点「${r.siteName}」がありません(先に拠点を追加してください)`);
    if ("value" in v) {
      const first = seen.get(v.value.employeeCode);
      if (first !== undefined) errors.push(`社員番号が ${first} 行目と重複しています`);
      else seen.set(v.value.employeeCode, r.line);
    }
    if (errors.length > 0 || !("value" in v) || !siteId) return { line: r.line, action: "error", errors };

    const cur = existing.get(v.value.employeeCode);
    if (!cur) {
      // 新しく追加する行: 同一人物と思われる登録者がいないか(氏名と生年月日、またはフリガナと生年月日)
      const dup = sameIndividual(v.value);
      if (dup) return { line: r.line, action: "error", errors: [dup] };
      // 未払いで新規登録を止めている間も、既存の登録者の更新はできる
      if (!canCreate) return { line: r.line, action: "error", errors: [RESTRICTED_MESSAGE] };
      return { line: r.line, action: "create", value: { ...v.value, siteId } };
    }
    if (cur.status === "archived") return { line: r.line, action: "error", errors: ["この社員番号の登録者はアーカイブ済みです"] };
    // 空欄の任意項目は変更しない
    const changes: Partial<Record<Field, string>> = {};
    if (cur.siteId !== siteId) changes.siteId = siteId;
    if (cur.name !== v.value.name) changes.name = v.value.name;
    if (v.value.nationality !== null && cur.nationality !== v.value.nationality) changes.nationality = v.value.nationality;
    if (v.value.birthDate !== null && cur.birthDate !== v.value.birthDate) changes.birthDate = v.value.birthDate;
    if (v.value.nameKana !== null && cur.nameKana !== v.value.nameKana) changes.nameKana = v.value.nameKana;
    if (v.value.phone !== null && cur.phone !== v.value.phone) changes.phone = v.value.phone;
    if (v.value.hiredAt !== null && cur.hiredAt !== v.value.hiredAt) changes.hiredAt = v.value.hiredAt;
    return Object.keys(changes).length === 0 ? { line: r.line, action: "unchanged" } : { line: r.line, action: "update", id: cur.id, changes };
  });
}

const present = (p: Planned): z.infer<typeof rowResult> => ({
  line: p.line,
  action: p.action,
  fields: p.action === "update" ? Object.keys(p.changes).sort() : [],
  errors: p.action === "error" ? p.errors : [],
});

export const importsRouter = router({
  previewPersons: permissionProcedure("imports.run")
    .input(personImportInput)
    .output(z.object({ rows: z.array(rowResult) }))
    // 保存しないが、行数が多く URL に載らないため mutation にする(既存の登録者との突き合わせなので監査ログに残す)
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const canCreate = (await tenantRestriction(tx, ctx.services.now())).state !== "restricted";
        const planned = await plan(tx, input.rows, canCreate);
        await ctx.audit(tx, { action: "person.import_preview", detail: { rows: planned.length } });
        return { rows: planned.map(present) };
      }),
    ),

  commitPersons: permissionProcedure("imports.run")
    .input(personImportInput.extend({ skipErrors: z.boolean().default(false) }))
    .output(z.object({ created: z.number(), updated: z.number(), unchanged: z.number(), skipped: z.number() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const canCreate = (await tenantRestriction(tx, ctx.services.now())).state !== "restricted";
        const planned = await plan(tx, input.rows, canCreate);
        const skipped = planned.filter((p) => p.action === "error").length;
        if (skipped > 0 && !input.skipErrors) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `エラーの行が ${skipped} 行あります。直すか、エラーの行を除いて取り込んでください` });
        }
        let created = 0;
        let updated = 0;
        for (const p of planned) {
          if (p.action === "create") {
            const id = await createPerson(tx, p.value);
            await ctx.audit(tx, { action: "person.create", targetType: "person", targetId: id, detail: { via: "csv_import" } });
            created++;
          } else if (p.action === "update") {
            await updatePerson(tx, p.id, p.changes);
            await ctx.audit(tx, { action: "person.update", targetType: "person", targetId: p.id, detail: { via: "csv_import", fields: Object.keys(p.changes).sort() } });
            updated++;
          }
        }
        const unchanged = planned.filter((p) => p.action === "unchanged").length;
        await ctx.audit(tx, { action: "person.import", detail: { rows: planned.length, created, updated, unchanged, skipped } });
        return { created, updated, unchanged, skipped };
      }),
    ),
});
