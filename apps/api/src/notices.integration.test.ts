/** 外国人雇用状況の届出(第1段階)。TEST_DATABASE_URL が無ければスキップ */
import { TRPCError } from "@trpc/server";
import { schema, withPlatform } from "@zairyu/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("外国人雇用状況の届出", () => {
  let h: Harness;
  let tenant: string;
  let tokyo: string;
  let osaka: string;
  let admin: AppCaller;
  let osakaAdmin: AppCaller;
  let viewer: AppCaller;
  let adminId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHarness("api_notices");
    h.clock.now = Date.parse("2026-05-01T03:00:00Z");
    tenant = await h.createTenant("A");
    tokyo = await h.createSite(tenant, "本社");
    osaka = await h.createSite(tenant, "大阪");
    adminId = await h.createUser(tenant, "admin@example.com", "tenant_admin");
    admin = await h.callerAs(tenant, adminId);
    osakaAdmin = await h.callerAs(tenant, await h.createUser(tenant, "osaka@example.com", "site_admin", [osaka]));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [tokyo]));
    await withPlatform(h.db, (tx) => tx.update(schema.tenants).set({ noticesFrom: "2026-04-01" }).where(eq(schema.tenants.id, tenant)));
    const mk = async (code: string, v: Record<string, unknown>) =>
      (ids[code] = (await admin.persons.create({ siteId: tokyo, employeeCode: code, name: `NAME ${code}`, ...v })).id);
    await mk("INS", { hiredAt: "2026-04-10", employmentInsured: true, birthDate: "1990-01-01" });
    await mk("PART", { hiredAt: "2026-04-20", employmentInsured: false, birthDate: "1991-01-01" });
    await mk("UNSET", { hiredAt: "2026-04-25", birthDate: "1992-01-01" });
    await mk("OLD", { hiredAt: "2026-03-01", employmentInsured: true, birthDate: "1993-01-01" }); // 管理の開始日より前
    ids.OSAKA = (await admin.persons.create({ siteId: osaka, employeeCode: "OSAKA", name: "NAME OSAKA", hiredAt: "2026-04-15", employmentInsured: false, birthDate: "1994-01-01" })).id;
  });
  afterAll(async () => h?.end());

  it("雇入れの届出を期限つきで一覧にする(雇用保険の有無で書式と期限が変わる。管理の開始日より前は出さない)", async () => {
    const { from, items } = await admin.notices.list();
    expect(from).toBe("2026-04-01");
    const by = (code: string) => items.find((i) => i.employeeCode === code);
    expect(by("OLD")).toBeUndefined();
    expect(by("INS")).toMatchObject({ kind: "hire", eventDate: "2026-04-10", dueDate: "2026-05-10", daysLeft: 9, status: "pending", form: expect.stringContaining("資格取得届") });
    expect(by("PART")).toMatchObject({ dueDate: "2026-05-31", form: expect.stringContaining("様式第3号") });
    expect(by("UNSET")).toMatchObject({ dueDate: "2026-05-10", missing: expect.arrayContaining(["雇用保険の加入"]) });
    expect(by("INS")?.missing).toEqual(expect.arrayContaining(["事業所の所在地", "在留資格", "在留カード番号"]));
    // 期限の近い順
    expect(items.map((i) => i.dueDate)).toEqual([...items.map((i) => i.dueDate)].sort());
    // 担当の拠点だけ。閲覧者は使えない
    expect((await osakaAdmin.notices.list()).items.map((i) => i.employeeCode)).toEqual(["OSAKA"]);
    expect(await codeOf(viewer.notices.list())).toBe("FORBIDDEN");
  });

  it("事業所と事業主の情報を入れると、記入内容の空欄が埋まる", async () => {
    await admin.org.sites.update({ id: tokyo, officialName: "株式会社例 本社", address: "東京都新宿区西新宿2-8-1", phone: "03-0000-0000", insuranceOfficeNumber: "1234-567890-1" });
    expect(await codeOf(admin.org.sites.update({ id: tokyo, insuranceOfficeNumber: "abc" }))).toBe("BAD_REQUEST");
    await admin.org.settings.updateEmployer({ name: "株式会社例", address: "東京都新宿区西新宿2-8-1", phone: "03-0000-0000", representativeName: "例 太郎" });
    expect(await admin.org.settings.employer()).toMatchObject({ name: "株式会社例", representativeName: "例 太郎", noticesFrom: "2026-04-01" });
    // 管理を始める日を早めると、前の入社も一覧に出る(未来の日付は不可)
    await admin.org.settings.updateEmployer({ noticesFrom: "2026-02-01" });
    expect((await admin.notices.list()).items.some((i) => i.employeeCode === "OLD")).toBe(true);
    expect(await codeOf(admin.org.settings.updateEmployer({ noticesFrom: "2026-12-01" }))).toBe("BAD_REQUEST");
    await admin.org.settings.updateEmployer({ noticesFrom: "2026-04-01" });
    const d = await admin.notices.detail({ personId: ids.INS!, kind: "hire", eventDate: "2026-04-10" });
    const f = (label: string) => d.fields.find((x) => x.label === label)?.value;
    expect(f("外国人の氏名(ローマ字)")).toBe("NAME INS");
    expect(f("事業所の名称")).toBe("株式会社例 本社");
    expect(f("雇用保険適用事業所番号")).toBe("1234-567890-1");
    expect(f("事業主の氏名(代表者)")).toBe("例 太郎");
    expect(f("雇入れ年月日")).toBe("2026-04-10");
    expect(d.item.missing).not.toContain("事業所の所在地");
    expect(await codeOf(admin.notices.detail({ personId: ids.OLD!, kind: "hire", eventDate: "2026-03-01" }))).toBe("NOT_FOUND");
  });

  it("提出を記録すると提出済みに。取り消すと未提出に戻る。監査ログに残る", async () => {
    const key = { personId: ids.INS!, kind: "hire" as const, eventDate: "2026-04-10" };
    expect(await codeOf(admin.notices.record({ ...key, status: "submitted" }))).toBe("BAD_REQUEST");
    await admin.notices.record({ ...key, status: "submitted", submittedOn: "2026-04-28", method: "hellowork_internet", receiptNo: "R-001" });
    const submitted = (await admin.notices.list({ status: "submitted" })).items;
    expect(submitted).toMatchObject([{ employeeCode: "INS", status: "submitted", record: { submittedOn: "2026-04-28", method: "hellowork_internet", receiptNo: "R-001" } }]);
    expect((await admin.notices.list()).items.some((i) => i.employeeCode === "INS")).toBe(false);
    expect(await admin.dashboard.summary()).toMatchObject({ notices: { pending: 3, overdue: 0 } });
    await admin.notices.clear(key);
    expect((await admin.notices.list()).items.some((i) => i.employeeCode === "INS")).toBe(true);
    // 担当外の拠点の人は記録できない
    expect(await codeOf(osakaAdmin.notices.record({ ...key, status: "not_required", note: "x" }))).toBe("NOT_FOUND");
    expect((await viewer.dashboard.summary()).notices).toBeNull();
  });

  it("退職すると離職の届出が出る(雇用保険の被保険者は離職日の翌日の翌日から10日以内)", async () => {
    h.clock.now = Date.parse("2026-05-20T03:00:00Z");
    admin = await h.callerAs(tenant, adminId); // 時計を進めたのでログインし直す
    await admin.persons.retire({ id: ids.INS!, reasonCode: "self", retiredAt: "2026-05-15" });
    const sep = (await admin.notices.list()).items.find((i) => i.employeeCode === "INS" && i.kind === "separation");
    expect(sep).toMatchObject({ eventDate: "2026-05-15", dueDate: "2026-05-26", daysLeft: 6, form: expect.stringContaining("資格喪失届") });
  });
});
