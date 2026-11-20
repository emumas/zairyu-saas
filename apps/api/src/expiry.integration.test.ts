/**
 * 期限区分(1-11): SQL 版と TypeScript 版の判定一致、一覧の絞り込み、ダッシュボードの件数。
 * TEST_DATABASE_URL が無ければスキップ
 */
import { randomBytes } from "node:crypto";
import { expiryBucketSql, schema, withTenant } from "@zairyu/db";
import { addDays, classifyExpiry, EXPIRY_BUCKETS, type ExpiryBucket } from "@zairyu/shared";
import { eq, and } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;

/** 再現性のある乱数 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe.skipIf(!url)("期限区分", () => {
  let h: Harness;
  let tenant: string;
  let siteA: string;
  const BASE = "2026-04-01";

  async function addPerson(siteId: string, code: string, card: Partial<typeof schema.residenceCards.$inferInsert> | null, status: "active" | "retired" = "active") {
    return withTenant(h.db, tenant, async (tx) => {
      const [p] = await tx.insert(schema.persons).values({ siteId, employeeCode: code, name: code, status }).returning();
      if (card) {
        await tx.insert(schema.residenceCards).values({
          personId: p!.id,
          cardFormat: "gen2",
          cardNumberEnc: randomBytes(8),
          cardNumberHmac: randomBytes(32),
          icVerified: true,
          ...card,
        });
      }
      return p!.id;
    });
  }

  beforeAll(async () => {
    h = await createHarness("api_expiry");
    tenant = await h.createTenant("期限テスト");
    siteA = await h.createSite(tenant, "A");
  });
  afterAll(async () => h?.end());

  it("SQL 版と TypeScript 版の判定がランダムな 400 件 x 判定日 9 通りで一致する", async () => {
    const r = rng(42);
    const date = (spread: number) => (r() < 0.15 ? null : addDays(BASE, Math.floor(r() * spread * 2) - spread));
    for (let i = 0; i < 400; i++) {
      await addPerson(siteA, `R${i}`, r() < 0.05 ? null : {
        expiryDate: date(200),
        cardValidUntil: date(400),
        pendingApplication: r() < 0.3,
        icVerified: r() < 0.7,
        needsReview: r() < 0.1,
      });
    }
    // 境界(30/31/90/91 日、月末)を含む判定日
    const todays = [BASE, "2026-03-31", "2026-02-28", "2026-05-31", "2026-12-31", addDays(BASE, 30), addDays(BASE, 31), addDays(BASE, 90), addDays(BASE, -91)];
    for (const today of todays) {
      const rows = await withTenant(h.db, tenant, (tx) =>
        tx
          .select({
            code: schema.persons.employeeCode,
            sqlBucket: expiryBucketSql(today),
            card: {
              id: schema.residenceCards.id,
              expiryDate: schema.residenceCards.expiryDate,
              cardValidUntil: schema.residenceCards.cardValidUntil,
              pendingApplication: schema.residenceCards.pendingApplication,
              icVerified: schema.residenceCards.icVerified,
              needsReview: schema.residenceCards.needsReview,
            },
          })
          .from(schema.persons)
          .leftJoin(schema.residenceCards, and(eq(schema.residenceCards.personId, schema.persons.id), eq(schema.residenceCards.isCurrent, true))),
      );
      const mismatches = rows.filter((x) => x.sqlBucket !== classifyExpiry(x.card, today).bucket);
      expect(mismatches.map((m) => ({ today, ...m }))).toEqual([]);
      // すべての区分が少なくとも一度は出ている(テストデータが偏っていないこと)
      if (today === BASE) for (const b of EXPIRY_BUCKETS) expect(rows.some((x) => x.sqlBucket === b), b).toBe(true);
    }
  });

  describe("API", () => {
    let sub: string;
    let siteX: string;
    let siteY: string;

    beforeAll(async () => {
      sub = await h.createTenant("API用");
      tenant = sub; // 以降の addPerson はこのテナントに入れる
      siteX = await h.createSite(sub, "X");
      siteY = await h.createSite(sub, "Y");
      h.clock.now = Date.parse(`${BASE}T03:00:00Z`); // JST 2026-04-01 12:00
      await addPerson(siteX, "EXPIRED", { expiryDate: "2026-03-31" });
      await addPerson(siteX, "D30", { expiryDate: "2026-05-01", icVerified: false });
      await addPerson(siteX, "D90", { expiryDate: "2026-06-30", needsReview: true });
      await addPerson(siteY, "PENDING", { expiryDate: "2026-03-01", pendingApplication: true });
      await addPerson(siteY, "OK", { expiryDate: "2027-01-01" });
      await addPerson(siteY, "NOCARD", null);
      await addPerson(siteY, "RETIRED", { expiryDate: "2026-03-01" }, "retired");
    });

    it("ダッシュボードの件数(在籍中のみ)", async () => {
      const admin = await h.callerAs(sub, await h.createUser(sub, "dash-admin@example.com", "tenant_admin"));
      const s = await admin.dashboard.summary();
      expect(s.today).toBe("2026-04-01");
      expect(s.total).toBe(6);
      expect(s.buckets).toMatchObject({ expired: 1, within30: 1, within90: 1, pending: 1, ok: 1, noCard: 1, noExpiry: 0 });
      expect(s).toMatchObject({ icUnverified: 1, needsReview: 1 });
    });

    it("拠点の範囲で件数が絞られる(閲覧者も見られる)", async () => {
      const viewer = await h.callerAs(sub, await h.createUser(sub, "dash-viewer@example.com", "viewer", [siteY]));
      const s = await viewer.dashboard.summary();
      expect(s.total).toBe(3);
      expect(s.buckets).toMatchObject({ pending: 1, ok: 1, noCard: 1, expired: 0 });
      await expect(viewer.dashboard.summary({ siteId: siteX })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("一覧を期限区分・目印で絞り込め、各行に区分と残り日数が付く", async () => {
      const admin = await h.callerAs(sub, await h.createUser(sub, "list-admin2@example.com", "tenant_admin"));
      const r = await admin.persons.list({ expiryBuckets: ["expired", "within30"], sort: "expiryDate" });
      expect(r.items.map((p) => p.employeeCode)).toEqual(["EXPIRED", "D30"]);
      expect(r.items.map((p) => p.expiry.daysLeft)).toEqual([-1, 30]);
      expect(r.total).toBe(2);
      expect((await admin.persons.list({ icUnverified: true })).items.map((p) => p.employeeCode)).toEqual(["D30"]);
      expect((await admin.persons.list({ needsReview: true })).items.map((p) => p.employeeCode)).toEqual(["D90"]);
      const pending = (await admin.persons.list({ expiryBuckets: ["pending"] })).items[0]!;
      expect(pending.expiry).toMatchObject({ bucket: "pending", specialPeriodUntil: "2026-05-01", daysLeft: -31 });
    });

    it("判定日は JST(UTC 15:00 で翌日扱い)", async () => {
      h.clock.now = Date.parse("2026-04-01T15:00:00Z"); // JST 4/2 0:00
      const admin = await h.callerAs(sub, await h.createUser(sub, "jst-admin@example.com", "tenant_admin"));
      const d30 = (await admin.persons.list({ q: "D30" })).items[0]!;
      expect(d30.expiry.daysLeft).toBe(29);
      const bucketsOf = (await admin.dashboard.summary()).buckets as Record<ExpiryBucket, number>;
      expect(bucketsOf.expired).toBe(1);
    });
  });
});
