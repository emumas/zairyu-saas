/** 職種照合(テスト運用)。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { schema, withTenant } from "@zairyu/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("職種照合(テスト運用)", () => {
  let h: Harness;
  let tenant: string;
  let site: string;
  let admin: AppCaller;
  let siteAdmin: AppCaller;
  let viewer: AppCaller;
  const ids: Record<string, string> = {};

  const person = (code: string, card: Partial<typeof schema.residenceCards.$inferInsert>) =>
    withTenant(h.db, tenant, async (tx) => {
      const [p] = await tx.insert(schema.persons).values({ siteId: site, employeeCode: code, name: code }).returning();
      await tx.insert(schema.residenceCards).values({ personId: p!.id, cardFormat: "legacy", cardNumberEnc: randomBytes(8), cardNumberHmac: randomBytes(32), expiryDate: "2029-01-01", ...card });
      ids[code] = p!.id;
    });

  beforeAll(async () => {
    h = await createHarness("api_jobs");
    h.clock.now = Date.parse("2026-11-25T03:00:00Z");
    tenant = await h.createTenant("A");
    site = await h.createSite(tenant, "本社");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    siteAdmin = await h.callerAs(tenant, await h.createUser(tenant, "site@example.com", "site_admin", [site]));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [site]));
    await person("SSW", { statusOfResidence: "特定技能1号", workRestriction: "4" });
    await person("GJ", { statusOfResidence: "技術・人文知識・国際業務", workRestriction: "2" });
    await person("STU", { statusOfResidence: "留学", workRestriction: "9", outsideActivity: "許可:原則週28時間以内・風俗営業等の従事を除く" });
  });
  afterAll(async () => h?.end());

  it("無効のあいだは使えない。テナント管理者が有効にする", async () => {
    expect(await admin.jobs.enabled()).toEqual({ enabled: false });
    expect(await codeOf(admin.jobs.categories.list())).toBe("BAD_REQUEST");
    expect(await codeOf(siteAdmin.jobs.setEnabled({ enabled: true }))).toBe("FORBIDDEN");
    await admin.jobs.setEnabled({ enabled: true });
    expect(await viewer.jobs.enabled()).toEqual({ enabled: true });
  });

  it("職種を登録して割り当てると、在留資格と照合する", async () => {
    const line = (await admin.jobs.categories.create({ name: "食品製造ライン", simpleWork: true, adultEntertainment: false, sswField: "food_manufacturing" })).id;
    const qa = (await admin.jobs.categories.create({ name: "品質管理", simpleWork: false, adultEntertainment: false, sswField: null })).id;
    const bar = (await admin.jobs.categories.create({ name: "接待飲食", simpleWork: false, adultEntertainment: true, sswField: null })).id;
    expect(await codeOf(siteAdmin.jobs.categories.create({ name: "x", simpleWork: false, adultEntertainment: false, sswField: null }))).toBe("FORBIDDEN");

    await siteAdmin.jobs.assign({ personId: ids.SSW!, jobCategoryId: line });
    expect((await admin.jobs.person({ personId: ids.SSW! })).match).toMatchObject({ level: "check", reasons: [expect.stringContaining("指定書の分野")] });
    await siteAdmin.jobs.assign({ personId: ids.SSW!, sswField: "kaigo" });
    expect((await admin.jobs.person({ personId: ids.SSW! })).match.level).toBe("ng");
    await siteAdmin.jobs.assign({ personId: ids.SSW!, sswField: "food_manufacturing" });
    expect((await admin.jobs.person({ personId: ids.SSW! })).match.level).toBe("check");

    await siteAdmin.jobs.assign({ personId: ids.STU!, jobCategoryId: bar });
    expect((await admin.jobs.person({ personId: ids.STU! })).match.level).toBe("ng");
    await siteAdmin.jobs.assign({ personId: ids.STU!, jobCategoryId: line });
    expect((await admin.jobs.person({ personId: ids.STU! })).match.level).toBe("ok");

    await siteAdmin.jobs.assign({ personId: ids.GJ!, jobCategoryId: qa });
    expect((await admin.jobs.person({ personId: ids.GJ! })).match.level).toBe("check");
    expect(await codeOf(viewer.jobs.assign({ personId: ids.GJ!, jobCategoryId: line }))).toBe("FORBIDDEN");
  });

  it("確認を記録すると問題なしになる(記録は追加だけ・閲覧者には見せない)", async () => {
    await siteAdmin.jobs.check({ personId: ids.GJ!, result: "ok", items: ["業務は専門的な知識・技術・国際的な感性を要する内容か(単純作業が中心でない)"], note: "業務内容を面談で確認" });
    const r = await admin.jobs.person({ personId: ids.GJ! });
    expect(r.match.level).toBe("ok");
    expect(r.history).toMatchObject([{ jobName: "品質管理", result: "ok", items: [expect.any(String)], checkedByEmail: "site@example.com" }]);
    expect((await viewer.jobs.person({ personId: ids.GJ! })).history).toEqual([]);
    // 確認の記録は変更・削除できない(DB の権限)
    await expect(withTenant(h.db, tenant, (tx) => tx.delete(schema.jobChecks))).rejects.toThrow();
    // 職種を外すと none
    await siteAdmin.jobs.assign({ personId: ids.GJ!, jobCategoryId: null });
    expect((await admin.jobs.person({ personId: ids.GJ! })).match.level).toBe("none");
    expect(await codeOf(siteAdmin.jobs.check({ personId: ids.GJ!, result: "ok", items: [] }))).toBe("BAD_REQUEST");
  });
});
