/** 就労可否の判定(カードの記載による)。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import { schema, withTenant } from "@zairyu/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("就労可否", () => {
  let h: Harness;
  let tenant: string;
  let site: string;
  let admin: AppCaller;
  let viewer: AppCaller;
  const ids: Record<string, string> = {};

  async function person(code: string, card: Partial<typeof schema.residenceCards.$inferInsert> | null, revoked = false) {
    await withTenant(h.db, tenant, async (tx) => {
      const [p] = await tx.insert(schema.persons).values({ siteId: site, employeeCode: code, name: code }).returning();
      ids[code] = p!.id;
      if (!card) return;
      const [c] = await tx
        .insert(schema.residenceCards)
        .values({ personId: p!.id, cardFormat: "gen2", cardNumberEnc: randomBytes(8), cardNumberHmac: randomBytes(32), icVerified: true, expiryDate: "2029-06-20", ...card })
        .returning();
      if (revoked) {
        const [u] = await tx.select().from(schema.users);
        await tx.insert(schema.verifications).values({ cardId: c!.id, method: "revocation_check", result: "revoked", performedBy: u!.id });
      }
    });
  }

  beforeAll(async () => {
    h = await createHarness("api_work");
    h.clock.now = Date.parse("2026-04-01T03:00:00Z");
    tenant = await h.createTenant("A");
    site = await h.createSite(tenant, "本社");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [site]));
    await person("PERM", { statusOfResidence: "永住者", workRestriction: "1", expiryDate: null, cardValidUntil: "2030-01-01" });
    await person("ENG", { statusOfResidence: "技術・人文知識・国際業務", workRestriction: "2" });
    await person("SSW", { statusOfResidence: "特定技能1号", workRestriction: "4" });
    await person("STU", { statusOfResidence: "留学", workRestriction: "9", outsideActivity: "1" });
    await person("STU-NO", { statusOfResidence: "留学", workRestriction: "9", outsideActivity: "0" });
    await person("EXPIRED", { statusOfResidence: "技能", workRestriction: "2", expiryDate: "2026-03-01" });
    await person("REVOKED", { statusOfResidence: "永住者", workRestriction: "1" }, true);
    await person("NOCARD", null);
  });
  afterAll(async () => h?.end());

  it("登録者ごとに判定と理由・確認事項を返す(閲覧者にも見せる)", async () => {
    expect((await admin.persons.get({ id: ids.PERM! })).work).toMatchObject({ level: "ok" });
    const eng = (await admin.persons.get({ id: ids.ENG! })).work;
    expect(eng.level).toBe("conditional");
    expect(eng.checks.join()).toContain("単純作業");
    expect((await admin.persons.get({ id: ids.STU! })).work).toMatchObject({ level: "conditional", weeklyHoursLimit: 28 });
    expect((await admin.persons.get({ id: ids["STU-NO"]! })).work.level).toBe("ng");
    expect((await admin.persons.get({ id: ids.EXPIRED! })).work.level).toBe("ng");
    expect((await admin.persons.get({ id: ids.REVOKED! })).work).toMatchObject({ level: "ng", reasons: [expect.stringContaining("失効")] });
    expect((await admin.persons.get({ id: ids.NOCARD! })).work.level).toBe("check");
    expect((await viewer.persons.get({ id: ids.SSW! })).work.level).toBe("conditional");
  });

  it("就労可否で絞り込める。ダッシュボードに区分ごとの件数", async () => {
    const ng = await admin.persons.list({ workLevels: ["ng"] });
    expect(ng.items.map((p) => p.employeeCode).sort()).toEqual(["EXPIRED", "REVOKED", "STU-NO"]);
    expect(ng.total).toBe(3);
    const paged = await admin.persons.list({ workLevels: ["conditional"], limit: 2, offset: 0 });
    expect(paged).toMatchObject({ total: 3 });
    expect(paged.items).toHaveLength(2);
    expect((await admin.dashboard.summary()).work).toEqual({ ok: 1, conditional: 3, ng: 3, check: 1 });
  });
});
