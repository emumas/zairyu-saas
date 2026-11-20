/** 登録者 API(1-6)と監査ログ(1-5)の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";
import { createCallerFactory, permissionProcedure, router } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("登録者 API と監査ログ", () => {
  let h: Harness;
  let tenant: string;
  let otherTenant: string;
  let tokyo: string;
  let osaka: string;
  let otherSite: string;
  const u = { admin: "", tokyo: "", viewer: "", other: "" };
  type C = AppCaller;
  let admin: C;
  let tokyoAdmin: C;
  let viewer: C;

  beforeAll(async () => {
    h = await createHarness("api_persons");
    tenant = await h.createTenant("A社");
    otherTenant = await h.createTenant("B社");
    tokyo = await h.createSite(tenant, "東京");
    osaka = await h.createSite(tenant, "大阪");
    otherSite = await h.createSite(otherTenant, "B社拠点");
    u.admin = await h.createUser(tenant, "admin@example.com", "tenant_admin");
    u.tokyo = await h.createUser(tenant, "tokyo@example.com", "site_admin", [tokyo]);
    u.viewer = await h.createUser(tenant, "viewer@example.com", "viewer", [tokyo]);
    u.other = await h.createUser(otherTenant, "other@example.com", "tenant_admin");
    admin = await h.callerAs(tenant, u.admin);
    tokyoAdmin = await h.callerAs(tenant, u.tokyo);
    viewer = await h.callerAs(tenant, u.viewer);
  });
  afterAll(async () => h?.end());

  const auditOf = (targetId: string) =>
    withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, targetId)));

  describe("登録と取得", () => {
    it("登録・取得でき、監査ログに記録される", async () => {
      const { id } = await tokyoAdmin.persons.create({ siteId: tokyo, employeeCode: "T001", name: "グエン ヴァン アン", nationality: "VNM", birthDate: "1995-04-01" });
      const p = await tokyoAdmin.persons.get({ id });
      expect(p).toMatchObject({ employeeCode: "T001", siteName: "東京", status: "active", nationality: "VNM", birthDate: "1995-04-01", card: null });
      const logs = await auditOf(id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: "person.create", actorId: u.tokyo, targetType: "person", ip: "10.0.0.1" });
    });

    it("担当外の拠点には登録できない", async () => {
      expect(await codeOf(tokyoAdmin.persons.create({ siteId: osaka, employeeCode: "X1", name: "x" }))).toBe("NOT_FOUND");
    });

    it("他テナントの拠点 ID を指定しても登録できない", async () => {
      expect(await codeOf(admin.persons.create({ siteId: otherSite, employeeCode: "X2", name: "x" }))).toBe("BAD_REQUEST");
    });

    it("社員番号の重複は CONFLICT", async () => {
      await admin.persons.create({ siteId: osaka, employeeCode: "DUP", name: "a" });
      expect(await codeOf(admin.persons.create({ siteId: tokyo, employeeCode: "DUP", name: "b" }))).toBe("CONFLICT");
    });

    it("入力の検証(国籍・日付・社員番号)", async () => {
      expect(await codeOf(admin.persons.create({ siteId: tokyo, employeeCode: "V1", name: "a", nationality: "vn" }))).toBe("BAD_REQUEST");
      expect(await codeOf(admin.persons.create({ siteId: tokyo, employeeCode: "V2", name: "a", birthDate: "1995-02-30" }))).toBe("BAD_REQUEST");
      expect(await codeOf(admin.persons.create({ siteId: tokyo, employeeCode: "社員1", name: "a" }))).toBe("BAD_REQUEST");
    });

    it("閲覧者は登録できず、取得しても生年月日・国籍は見えない", async () => {
      const { id } = await admin.persons.create({ siteId: tokyo, employeeCode: "T002", name: "a", nationality: "PHL", birthDate: "2000-01-01" });
      expect(await codeOf(viewer.persons.create({ siteId: tokyo, employeeCode: "T003", name: "b" }))).toBe("FORBIDDEN");
      expect(await viewer.persons.get({ id })).toMatchObject({ nationality: null, birthDate: null, employeeCode: "T002" });
    });

    it("他テナントの登録者は見えない", async () => {
      const { id } = await admin.persons.create({ siteId: tokyo, employeeCode: "T004", name: "a" });
      const other = await h.callerAs(otherTenant, u.other);
      expect(await codeOf(other.persons.get({ id }))).toBe("NOT_FOUND");
    });
  });

  describe("一覧", () => {
    let listTenant: string;
    let lt: C;
    let ltSite: C;
    let s1: string;

    beforeAll(async () => {
      listTenant = await h.createTenant("一覧用");
      s1 = await h.createSite(listTenant, "S1");
      const s2 = await h.createSite(listTenant, "S2");
      lt = await h.callerAs(listTenant, await h.createUser(listTenant, "list-admin@example.com", "tenant_admin"));
      ltSite = await h.callerAs(listTenant, await h.createUser(listTenant, "list-site@example.com", "site_admin", [s1]));
      for (let i = 1; i <= 25; i++) {
        await lt.persons.create({ siteId: i % 2 ? s1 : s2, employeeCode: `E${String(i).padStart(3, "0")}`, name: i === 7 ? "山田 100%" : `社員${i}` });
      }
    });

    it("ページングと件数", async () => {
      const p1 = await lt.persons.list({ limit: 10, offset: 0 });
      const p3 = await lt.persons.list({ limit: 10, offset: 20 });
      expect(p1.total).toBe(25);
      expect(p1.items.map((p) => p.employeeCode)[0]).toBe("E001");
      expect(p3.items).toHaveLength(5);
    });

    it("拠点管理者は担当拠点だけ", async () => {
      const r = await ltSite.persons.list({ limit: 100 });
      expect(r.total).toBe(13);
      expect(r.items.every((p) => p.siteId === s1)).toBe(true);
    });

    it("氏名の部分一致・社員番号の前方一致。% などはワイルドカードにならない", async () => {
      expect((await lt.persons.list({ q: "E02" })).items.map((p) => p.employeeCode)).toEqual(["E020", "E021", "E022", "E023", "E024", "E025"]);
      expect((await lt.persons.list({ q: "100%" })).items.map((p) => p.employeeCode)).toEqual(["E007"]);
      expect((await lt.persons.list({ q: "%" })).total).toBe(1);
    });

    it("既定ではアーカイブを含まない", async () => {
      const r = await lt.persons.list({ q: "E001" });
      await lt.persons.archive({ id: r.items[0]!.id });
      expect((await lt.persons.list({ q: "E001" })).total).toBe(0);
      expect((await lt.persons.list({ q: "E001", statuses: ["archived"] })).total).toBe(1);
    });
  });

  describe("更新・退職・復職・アーカイブ", () => {
    it("更新した項目名だけを監査ログに残す(値は残さない)", async () => {
      const { id } = await admin.persons.create({ siteId: tokyo, employeeCode: "U001", name: "旧姓" });
      await admin.persons.update({ id, name: "新姓", birthDate: "1990-01-01" });
      const logs = await auditOf(id);
      const upd = logs.find((l) => l.action === "person.update");
      expect(upd?.detail).toEqual({ fields: ["birthDate", "name"] });
      expect(JSON.stringify(logs)).not.toContain("新姓");
      expect((await admin.persons.get({ id })).name).toBe("新姓");
    });

    it("担当外の拠点への移動はできない", async () => {
      const { id } = await tokyoAdmin.persons.create({ siteId: tokyo, employeeCode: "U002", name: "a" });
      expect(await codeOf(tokyoAdmin.persons.update({ id, siteId: osaka }))).toBe("NOT_FOUND");
      await admin.persons.update({ id, siteId: osaka });
      // 移動後は東京の拠点管理者から見えない
      expect(await codeOf(tokyoAdmin.persons.get({ id }))).toBe("NOT_FOUND");
    });

    it("退職日は既定で JST の今日。復職で元に戻る", async () => {
      h.clock.now = Date.parse("2026-03-31T15:30:00Z"); // JST 4/1 0:30
      const { id } = await admin.persons.create({ siteId: tokyo, employeeCode: "R001", name: "a" });
      expect((await admin.persons.retire({ id })).retiredAt).toBe("2026-04-01");
      expect(await admin.persons.get({ id })).toMatchObject({ status: "retired", retiredAt: "2026-04-01" });
      expect(await codeOf(admin.persons.retire({ id }))).toBe("BAD_REQUEST");
      await admin.persons.reactivate({ id });
      expect(await admin.persons.get({ id })).toMatchObject({ status: "active", retiredAt: null });
      const actions = (await auditOf(id)).map((l) => l.action).sort();
      expect(actions).toEqual(["person.create", "person.reactivate", "person.retire"]);
    });

    it("アーカイブ後は変更できない", async () => {
      const { id } = await admin.persons.create({ siteId: tokyo, employeeCode: "A001", name: "a" });
      await admin.persons.archive({ id });
      expect(await admin.persons.get({ id })).toMatchObject({ status: "archived" });
      expect(await codeOf(admin.persons.update({ id, name: "b" }))).toBe("BAD_REQUEST");
    });
  });

  describe("監査ログの強制(1-5)", () => {
    const forgetful = router({
      // 監査ログを書き忘れた変更系の手続き
      bad: permissionProcedure("persons.write").mutation(({ ctx }) =>
        ctx.tenantTx(async (tx) => {
          await tx.insert(schema.sites).values({ name: "書き忘れ" });
          return "done";
        }),
      ),
    });

    it("監査ログを書かない mutation はエラーになり、変更もロールバックされる", async () => {
      const access = await h.accessToken(tenant, u.admin);
      const c = createCallerFactory(forgetful)({ requestId: "t", services: h.services, accessToken: access, ip: null });
      expect(await codeOf(c.bad())).toBe("INTERNAL_SERVER_ERROR");
      const sites = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.sites).where(eq(schema.sites.name, "書き忘れ")));
      expect(sites).toHaveLength(0);
    });
  });
});
