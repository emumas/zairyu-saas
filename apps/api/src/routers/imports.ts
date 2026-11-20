/**
 * 従業員マスタの CSV 一括取込(1-10)。テナント管理者のみ(imports.run)。
 * CSV の読み込み(文字コード・列の対応)は Web で行い、ここでは行ごとの値を受け取る。
 * - preview: 行ごとに 新規 / 更新 / 変更なし / エラー を返す(保存しない)
 * - commit: もう一度同じ判定をして、エラーの無い行を 1 つのトランザクションで保存する
 * 結果に氏名などの値は含めない(呼び出し側が CSV を持っている)。監査ログにも値は残さない
 */
import { createPerson, findPersonsByEmployeeCodes, listSites, updatePerson, type Tx } from "@zairyu/db";
import { personImportInput, validateImportRow, type PersonImportRow } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { permissionProcedure, router } from "../trpc.js";

type Field = "siteId" | "name" | "nationality" | "birthDate";
type Planned =
  | { line: number; action: "error"; errors: string[] }
  | { line: number; action: "unchanged" }
  | { line: number; action: "create"; value: { siteId: string; employeeCode: string; name: string; nationality: string | null; birthDate: string | null } }
  | { line: number; action: "update"; id: string; changes: Partial<Record<Field, string>> };

const rowResult = z.object({
  line: z.number(),
  action: z.enum(["create", "update", "unchanged", "error"]),
  /** 更新する項目名(siteId / name / nationality / birthDate) */
  fields: z.array(z.string()),
  errors: z.array(z.string()),
});

async function plan(tx: Tx, rows: readonly PersonImportRow[]): Promise<Planned[]> {
  const sites = new Map((await listSites(tx)).filter((s) => !s.archivedAt).map((s) => [s.name, s.id]));
  const existing = new Map((await findPersonsByEmployeeCodes(tx, [...new Set(rows.map((r) => r.employeeCode.trim()))])).map((p) => [p.employeeCode, p]));
  const seen = new Map<string, number>();
  return rows.map((r): Planned => {
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
    if (!cur) return { line: r.line, action: "create", value: { ...v.value, siteId } };
    if (cur.status === "archived") return { line: r.line, action: "error", errors: ["この社員番号の登録者はアーカイブ済みです"] };
    // 空欄の任意項目は変更しない
    const changes: Partial<Record<Field, string>> = {};
    if (cur.siteId !== siteId) changes.siteId = siteId;
    if (cur.name !== v.value.name) changes.name = v.value.name;
    if (v.value.nationality !== null && cur.nationality !== v.value.nationality) changes.nationality = v.value.nationality;
    if (v.value.birthDate !== null && cur.birthDate !== v.value.birthDate) changes.birthDate = v.value.birthDate;
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
        const planned = await plan(tx, input.rows);
        await ctx.audit(tx, { action: "person.import_preview", detail: { rows: planned.length } });
        return { rows: planned.map(present) };
      }),
    ),

  commitPersons: permissionProcedure("imports.run")
    .input(personImportInput.extend({ skipErrors: z.boolean().default(false) }))
    .output(z.object({ created: z.number(), updated: z.number(), unchanged: z.number(), skipped: z.number() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        // TODO(1-18): 未払いの猶予期間を過ぎたテナントは新規登録を止める
        const planned = await plan(tx, input.rows);
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
