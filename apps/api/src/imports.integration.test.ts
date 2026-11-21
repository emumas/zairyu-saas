/** CSV 一括取込(1-10)・確認履歴/監査ログの出力(1-14)の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const row = (line: number, employeeCode: string, name: string, siteName: string, nationality = "", birthDate = "") => ({ line, employeeCode, name, siteName, nationality, birthDate });

describe.skipIf(!url)("CSV 一括取込と出力", () => {
  let h: Harness;
  let tenant: string;
  let other: string;
  let tokyo: string;
  let osaka: string;
  let adminId: string;
  let admin: AppCaller;
  let otherAdmin: AppCaller;
  let siteAdmin: AppCaller;

  beforeAll(async () => {
    h = await createHarness("api_imports");
    tenant = await h.createTenant("A");
    other = await h.createTenant("B");
    tokyo = await h.createSite(tenant, "東京");
    osaka = await h.createSite(tenant, "大阪");
    await h.createSite(other, "東京");
    adminId = await h.createUser(tenant, "admin@example.com", "tenant_admin");
    admin = await h.callerAs(tenant, adminId);
    otherAdmin = await h.callerAs(other, await h.createUser(other, "admin@b.example.com", "tenant_admin"));
    siteAdmin = await h.callerAs(tenant, await h.createUser(tenant, "site@example.com", "site_admin", [tokyo]));
  });
  afterAll(async () => h?.end());

  it("テナント管理者以外は使えない", async () => {
    expect(await codeOf(siteAdmin.imports.previewPersons({ rows: [row(2, "E1", "A", "東京")] }))).toBe("FORBIDDEN");
    expect(await codeOf(siteAdmin.reports.verifications({ period: { from: "2026-01-01", to: "2026-01-31" } }))).toBe("FORBIDDEN");
  });

  it("プレビュー: 新規・更新・変更なし・エラーを判定し、保存しない", async () => {
    await admin.persons.create({ siteId: tokyo, employeeCode: "E1", name: "OLD NAME", nationality: "VNM" });
    await admin.persons.create({ siteId: tokyo, employeeCode: "E2", name: "SAME", nationality: "PHL", birthDate: "1990-01-01" });
    const archived = await admin.persons.create({ siteId: tokyo, employeeCode: "E9", name: "GONE" });
    await admin.persons.archive({ id: archived.id });

    const rows = [
      row(2, "E1", "NEW NAME", "大阪"), // 更新(氏名・拠点)。国籍の空欄は変更しない
      row(3, "E2", "SAME", "東京", "phl", "1990/1/1"), // 変更なし
      row(4, "E3", "NEW PERSON", "東京", "VNM", "1995-04-01"), // 新規
      row(5, "E3", "DUP", "東京"), // ファイル内の重複
      row(6, "E4", "X", "名古屋"), // 拠点なし
      row(7, "E5", "", "東京", "VN", "1995-13-01"), // 値の誤り
      row(8, "E9", "GONE", "東京"), // アーカイブ済み
    ];
    const { rows: r } = await admin.imports.previewPersons({ rows });
    expect(r.map((x) => [x.line, x.action, x.fields])).toEqual([
      [2, "update", ["name", "siteId"]],
      [3, "unchanged", []],
      [4, "create", []],
      [5, "error", []],
      [6, "error", []],
      [7, "error", []],
      [8, "error", []],
    ]);
    expect(r[3]!.errors).toEqual(["社員番号が 4 行目と重複しています"]);
    expect(r[4]!.errors[0]).toContain("名古屋");
    expect(r[5]!.errors).toHaveLength(3);
    // 保存されていない
    expect((await admin.persons.list({ q: "E3" })).total).toBe(0);

    // エラーがあると、明示しない限り取り込まない
    expect(await codeOf(admin.imports.commitPersons({ rows }))).toBe("BAD_REQUEST");
    expect((await admin.persons.list({ q: "E3" })).total).toBe(0);

    const result = await admin.imports.commitPersons({ rows, skipErrors: true });
    expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, skipped: 4 });
    const e1 = (await admin.persons.list({ q: "E1" })).items[0]!;
    expect(e1).toMatchObject({ name: "NEW NAME", siteId: osaka, nationality: "VNM" });
    const e3 = (await admin.persons.list({ q: "E3" })).items[0]!;
    expect(e3).toMatchObject({ name: "NEW PERSON", siteId: tokyo, nationality: "VNM", birthDate: "1995-04-01" });

    // 監査ログ: 個別の作成・更新(値は含まない)と取込のまとめ
    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs));
    expect(logs.find((l) => l.action === "person.update" && l.targetId === e1.id)?.detail).toEqual({ via: "csv_import", fields: ["name", "siteId"] });
    expect(logs.find((l) => l.action === "person.import")?.detail).toEqual({ rows: 7, created: 1, updated: 1, unchanged: 1, skipped: 4 });
    expect(JSON.stringify(logs)).not.toContain("NEW NAME");
  });

  it("新しく追加する行で同一人物を見つける(在籍中=二重登録の疑い、退職者=前回の退職理由)。同じファイル内の重複も", async () => {
    await admin.persons.create({ siteId: tokyo, employeeCode: "S1", name: "PHAM VAN C", birthDate: "1992-02-02" });
    const gone = await admin.persons.create({ siteId: tokyo, employeeCode: "S2", name: "LE THI D", birthDate: "1993-03-03", nameKana: "レ ティ ドー" });
    await admin.persons.retire({ id: gone.id, retiredAt: "2025-12-31", reasonCode: "contract_end", reasonNote: "再雇用可" });
    const rows = [
      { ...row(2, "N1", "Pham  Van C", "大阪", "", "1992/2/2") }, // 在籍中と同じ(表記ゆれ)
      { ...row(3, "N2", "LE T D", "東京", "", "1993-03-03"), nameKana: "れ てぃ どー" }, // フリガナと生年月日で退職者と一致
      { ...row(4, "N3", "NEW ONE", "東京", "", "2000-01-01") },
      { ...row(5, "N4", "new one", "東京", "", "2000-01-01") }, // ファイル内の重複
      { ...row(6, "N5", "PHAM VAN C", "東京") }, // 生年月日なしは確認しない
    ];
    const { rows: r } = await admin.imports.previewPersons({ rows });
    expect(r.map((x) => x.action)).toEqual(["error", "error", "create", "error", "create"]);
    expect(r[0]!.errors[0]).toContain("二重登録の疑い");
    expect(r[0]!.errors[0]).toContain("S1");
    expect(r[1]!.errors[0]).toContain("以前在籍していた方");
    expect(r[1]!.errors[0]).toContain("契約期間満了・再雇用可");
    expect(r[3]!.errors[0]).toContain("4 行目");
  });

  it("他のテナントの拠点名・社員番号とは突き合わせない", async () => {
    const { rows } = await otherAdmin.imports.previewPersons({ rows: [row(2, "E1", "X", "東京"), row(3, "E2", "Y", "大阪")] });
    expect(rows.map((r) => r.action)).toEqual(["create", "error"]);
  });

  it("確認履歴を期間・拠点で出力し、出力したことを監査ログに残す", async () => {
    const person = (await admin.persons.list({ q: "E3" })).items[0]!;
    await withTenant(h.db, tenant, async (tx) => {
      const [card] = await tx
        .insert(schema.residenceCards)
        .values({ personId: person.id, cardFormat: "legacy", cardNumberEnc: randomBytes(8), cardNumberHmac: randomBytes(32) })
        .returning();
      await tx.insert(schema.verifications).values([
        { cardId: card!.id, method: "ic_signature", result: "ok", performedBy: adminId, performedAt: new Date("2026-03-31T14:59:59Z") }, // JST 3/31 23:59
        { cardId: card!.id, method: "revocation_check", result: "ok", note: "=cmd", performedBy: adminId, performedAt: new Date("2026-03-31T15:00:00Z") }, // JST 4/1 0:00
      ]);
    });
    const march = await admin.reports.verifications({ period: { from: "2026-03-01", to: "2026-03-31" } });
    expect(march.rows.map((r) => [r.method, r.employeeCode, r.siteName, r.performedByEmail])).toEqual([["ic_signature", "E3", "東京", "admin@example.com"]]);
    const april = await admin.reports.verifications({ period: { from: "2026-04-01", to: "2026-04-01" }, siteId: tokyo });
    expect(april.rows.map((r) => r.method)).toEqual(["revocation_check"]);
    expect((await admin.reports.verifications({ period: { from: "2026-03-01", to: "2026-04-30" }, siteId: osaka })).rows).toEqual([]);
    // 他のテナントからは見えない
    expect((await otherAdmin.reports.verifications({ period: { from: "2026-03-01", to: "2026-04-30" } })).rows).toEqual([]);

    expect(await codeOf(admin.reports.verifications({ period: { from: "2026-04-01", to: "2026-03-01" } }))).toBe("BAD_REQUEST");
    expect(await codeOf(admin.reports.verifications({ period: { from: "2025-01-01", to: "2026-03-01" } }))).toBe("BAD_REQUEST");

    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "report.verifications_export")));
    expect(logs[0]?.detail).toEqual({ from: "2026-03-01", to: "2026-03-31", siteId: null, count: 1 });
  });

  it("監査ログを出力できる(他のテナントの記録は含まない)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(today >= from).toBe(true);
    const { rows } = await admin.reports.auditLogs({ period: { from, to } });
    expect(rows.some((r) => r.action === "person.import" && r.actorEmail === "admin@example.com")).toBe(true);
    expect(rows.every((r) => r.actorEmail !== "admin@b.example.com")).toBe(true);
  });
});
