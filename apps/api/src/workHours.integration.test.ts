/** 勤怠 CSV と週28時間の確認。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import { schema, withPurge, withTenant, deletePersonsData } from "@zairyu/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("週28時間の確認", () => {
  let h: Harness;
  let tenant: string;
  let other: string;
  let site: string;
  let admin: AppCaller;
  let siteAdmin: AppCaller;
  let viewer: AppCaller;
  let otherAdmin: AppCaller;
  const ids: Record<string, string> = {};

  async function person(t: string, s: string, code: string, outsideActivity: string | null) {
    await withTenant(h.db, t, async (tx) => {
      const [p] = await tx.insert(schema.persons).values({ siteId: s, employeeCode: code, name: code }).returning();
      ids[code] = p!.id;
      await tx.insert(schema.residenceCards).values({
        personId: p!.id,
        cardFormat: "gen2",
        cardNumberEnc: randomBytes(8),
        cardNumberHmac: randomBytes(32),
        icVerified: true,
        expiryDate: "2029-06-20",
        statusOfResidence: outsideActivity ? "留学" : "永住者",
        workRestriction: outsideActivity ? "9" : "1",
        outsideActivity,
      });
    });
  }
  const rows = (code: string, start: string, hours: number[], line = 2) =>
    hours.map((hr, i) => ({ line: line + i, employeeCode: code, date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), minutes: hr * 60 }));

  beforeAll(async () => {
    h = await createHarness("api_work_hours");
    h.clock.now = Date.parse("2026-04-30T03:00:00Z");
    tenant = await h.createTenant("A");
    other = await h.createTenant("B");
    site = await h.createSite(tenant, "本社");
    const site2 = await h.createSite(tenant, "工場");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    siteAdmin = await h.callerAs(tenant, await h.createUser(tenant, "site@example.com", "site_admin", [site2]));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [site]));
    otherAdmin = await h.callerAs(other, await h.createUser(other, "b@example.com", "tenant_admin"));
    await person(tenant, site, "S1", "1");
    await person(tenant, site, "S2", "1");
    await person(tenant, site, "S3", "1");
    await person(tenant, site, "PR", null);
  });
  afterAll(async () => h?.end());

  it("取り込み: 試しの実行では保存しない。誤りの行を返し、同じ日の複数行は合計する", async () => {
    const input = {
      rows: [
        // S1: 4/6〜4/12 は 4 時間ずつ(28 時間)、4/13・4/14 は 8 時間 → ずらした 7 日で 36 時間
        ...rows("S1", "2026-04-06", [4, 4, 4, 4, 4, 4, 4, 8, 4]),
        { line: 20, employeeCode: "S1", date: "2026-04-14", minutes: 240 },
        ...rows("S2", "2026-04-20", [4, 4, 4, 4, 4, 4], 30),
        { line: 40, employeeCode: "PR", date: "2026-04-20", minutes: 600 },
        { line: 41, employeeCode: "NONE", date: "2026-04-20", minutes: 60 },
        { line: 42, employeeCode: "S3", date: "2026-04-20", minutes: 900 },
        { line: 43, employeeCode: "S3", date: "2026-04-20", minutes: 900 },
      ],
    };
    const dry = await admin.workHours.importDays({ ...input, dryRun: true });
    expect(dry).toEqual({
      days: 16,
      persons: 3,
      notTargetRows: 1,
      errors: [
        { line: 41, errors: [expect.stringContaining("NONE")] },
        { line: 42, errors: [expect.stringContaining("24 時間")] },
      ],
    });
    expect((await admin.workHours.person({ personId: ids.S1! })).days).toEqual([]);
    expect(await admin.workHours.importDays(input)).toMatchObject({ days: 16 });
    const s1 = await admin.workHours.person({ personId: ids.S1! });
    expect(s1.days.find((d) => d.date === "2026-04-14")?.minutes).toBe(480);
    expect(s1).toMatchObject({ target: true, from: "2026-04-03", to: "2026-04-30", check: { status: "over", maxWindow: { from: "2026-04-08", to: "2026-04-14", minutes: 2160 } } });
  });

  it("再取込は同じ日を上書きする", async () => {
    await admin.workHours.importDays({ rows: rows("S1", "2026-04-13", [3, 3]) });
    const s1 = await admin.workHours.person({ personId: ids.S1! });
    expect(s1.check).toMatchObject({ status: "near", maxWindow: { from: "2026-04-06", minutes: 28 * 60 } });
  });

  it("一覧は対象者(包括許可)だけで、超過・注意を先に。ダッシュボードに人数", async () => {
    const list = await admin.workHours.list();
    expect(list.items.map((i) => [i.employeeCode, i.check.status])).toEqual([
      ["S1", "near"],
      ["S2", "near"],
      ["S3", "noData"],
    ]);
    expect((await viewer.workHours.list()).items).toHaveLength(3);
    expect((await admin.dashboard.summary()).weeklyHours).toEqual({ over: 0, near: 2, targets: 3 });
    // 期間を指定できる(93 日まで)
    const early = await admin.workHours.list({ period: { from: "2026-04-01", to: "2026-04-10" } });
    expect(early.items.find((i) => i.employeeCode === "S1")?.check).toMatchObject({ status: "ok", maxWindow: { from: "2026-04-04", minutes: 20 * 60 } });
    await expect(admin.workHours.list({ period: { from: "2026-01-01", to: "2026-04-30" } })).rejects.toThrow("93");
  });

  it("長期休業期間: 1 日 8 時間まで。登録・削除は編集できる人だけ", async () => {
    await admin.workHours.importDays({ rows: rows("S2", "2026-04-27", [9]) });
    expect((await admin.workHours.person({ personId: ids.S2! })).check.status).toBe("over");
    await expect(viewer.workHours.addBreak({ personId: ids.S2!, fromDate: "2026-04-25", toDate: "2026-05-10" })).rejects.toThrow();
    await expect(siteAdmin.workHours.addBreak({ personId: ids.S2!, fromDate: "2026-04-25", toDate: "2026-05-10" })).rejects.toThrow("見つかりません");
    const { id } = await admin.workHours.addBreak({ personId: ids.S2!, fromDate: "2026-04-25", toDate: "2026-05-10", note: "春休み" });
    const s2 = await admin.workHours.person({ personId: ids.S2! });
    expect(s2.breaks).toEqual([{ id, fromDate: "2026-04-25", toDate: "2026-05-10", note: "春休み" }]);
    expect(s2.check).toMatchObject({ status: "over", breakDaysOver: [{ date: "2026-04-27", minutes: 540 }] });
    await admin.workHours.importDays({ rows: rows("S2", "2026-04-27", [8]) });
    expect((await admin.workHours.person({ personId: ids.S2! })).check.status).not.toBe("over");
    await admin.workHours.removeBreak({ id });
    expect((await admin.workHours.person({ personId: ids.S2! })).breaks).toEqual([]);
  });

  it("取り込みはテナント管理者だけ。他テナントの社員番号・登録者は見えない", async () => {
    await expect(siteAdmin.workHours.importDays({ rows: rows("S1", "2026-04-01", [1]) })).rejects.toThrow();
    expect((await otherAdmin.workHours.importDays({ rows: rows("S1", "2026-04-01", [1]) })).errors).toHaveLength(1);
    await expect(otherAdmin.workHours.person({ personId: ids.S1! })).rejects.toThrow("見つかりません");
    expect((await otherAdmin.workHours.list()).items).toEqual([]);
  });

  it("登録者のデータ削除で勤怠と長期休業期間も消える", async () => {
    await admin.workHours.addBreak({ personId: ids.S1!, fromDate: "2026-08-01", toDate: "2026-08-31" });
    await withPurge(h.db, (tx) => deletePersonsData(tx, tenant, [ids.S1!]));
    const left = await withTenant(h.db, tenant, async (tx) => ({
      days: await tx.select().from(schema.workDays),
      breaks: await tx.select().from(schema.studyBreaks),
    }));
    expect(left.days.every((d) => d.personId !== ids.S1)).toBe(true);
    expect(left.breaks).toEqual([]);
  });
});
