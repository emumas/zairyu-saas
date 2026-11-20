/** 退職後データの自動削除(1-21)。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import { createDb, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { MemoryBlobStore } from "@zairyu/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeExpired } from "./purge.js";

const url = process.env.TEST_DATABASE_URL;
const at = (jstDate: string) => Date.parse(`${jstDate}T01:00:00+09:00`);

describe.skipIf(!url)("退職後データの自動削除", () => {
  let db: Db;
  let end: () => Promise<void>;
  let a: string;
  let b: string;
  const blobs = new MemoryBlobStore();
  const ids: Record<string, string> = {};

  /** 登録者とカード・画像・確認履歴・アラート・就労時間を作る */
  async function addPerson(tenant: string, code: string, v: Partial<typeof schema.persons.$inferInsert>) {
    await withTenant(db, tenant, async (tx) => {
      const [site] = await tx.select().from(schema.sites);
      const [p] = await tx.insert(schema.persons).values({ siteId: site!.id, employeeCode: code, name: `氏名${code}`, ...v }).returning();
      const [c] = await tx.insert(schema.residenceCards).values({ personId: p!.id, cardFormat: "legacy", cardNumberEnc: randomBytes(8), cardNumberHmac: randomBytes(32) }).returning();
      const key = `${tenant}/${code.toLowerCase()}-front`;
      await blobs.put(key, Buffer.from("encrypted"));
      await tx.insert(schema.cardImages).values({ cardId: c!.id, kind: "front", blobKey: key, contentType: "image/jpeg" });
      const [u] = await tx.select().from(schema.users);
      await tx.insert(schema.verifications).values({ cardId: c!.id, method: "visual", result: "ok", performedBy: u!.id });
      await tx.insert(schema.alerts).values({ personId: p!.id, cardId: c!.id, type: "expiry_30", dueDate: "2020-01-01" });
      await tx.insert(schema.workHours).values({ personId: p!.id, weekStart: "2019-12-30", minutes: 600 });
      await tx.insert(schema.auditLogs).values({ actorId: u!.id, action: "person.create", targetType: "person", targetId: p!.id });
      ids[code] = p!.id;
    });
  }
  const count = (tenant: string) =>
    withTenant(db, tenant, async (tx) => ({
      persons: (await tx.select().from(schema.persons)).map((p) => p.employeeCode).sort(),
      cards: (await tx.select().from(schema.residenceCards)).length,
      images: (await tx.select().from(schema.cardImages)).length,
      verifications: (await tx.select().from(schema.verifications)).length,
      alerts: (await tx.select().from(schema.alerts)).length,
      workHours: (await tx.select().from(schema.workHours)).length,
    }));

  beforeAll(async () => {
    const c = createDb(await prepareTestDatabase(url!, "worker_purge"), { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    await withPlatform(db, async (tx) => {
      a = (await tx.insert(schema.tenants).values({ name: "A", status: "active", retentionYears: 3 }).returning())[0]!.id;
      b = (await tx.insert(schema.tenants).values({ name: "B", status: "active", retentionYears: 5 }).returning())[0]!.id;
    });
    for (const t of [a, b]) {
      await withTenant(db, t, async (tx) => {
        await tx.insert(schema.sites).values({ name: "本社" });
        await tx.insert(schema.users).values({ email: `admin@${t}.example`, role: "tenant_admin", status: "active" });
      });
    }
    await addPerson(a, "A-RETIRED", { status: "retired", retiredAt: "2020-01-10" });
    await addPerson(a, "A-ACTIVE", {});
    await addPerson(a, "A-ARCHIVED", { status: "archived", archivedAt: new Date("2019-12-31T03:00:00Z") }); // 退職日なし → アーカイブ日
    await addPerson(a, "A-RECENT", { status: "retired", retiredAt: "2022-06-01" });
    await addPerson(b, "B-RETIRED", { status: "retired", retiredAt: "2020-01-10" }); // B は 5 年
  });
  afterAll(async () => end?.());

  it("保存期間の満了日までは消さない", async () => {
    expect(await purgeExpired(db, blobs, at("2023-01-10"))).toEqual([
      expect.objectContaining({ tenantId: a, persons: 1 }), // A-ARCHIVED(2019-12-31 + 3 年)だけ
    ]);
    expect((await count(a)).persons).toEqual(["A-ACTIVE", "A-RECENT", "A-RETIRED"]);
  });

  it("--dry-run は件数だけで消さない", async () => {
    expect(await purgeExpired(db, blobs, at("2023-01-11"), { dryRun: true })).toEqual([expect.objectContaining({ tenantId: a, persons: 1 })]);
    expect((await count(a)).persons).toContain("A-RETIRED");
  });

  it("満了日の翌日に、登録者・カード・画像(ファイルも)・確認履歴・アラート・就労時間を消し、監査ログに残す", async () => {
    const r = await purgeExpired(db, blobs, at("2023-01-11"));
    expect(r).toEqual([{ tenantId: a, persons: 1, cards: 1, images: 1, verifications: 1, blobFailures: 0 }]);
    expect(await count(a)).toEqual({ persons: ["A-ACTIVE", "A-RECENT"], cards: 2, images: 2, verifications: 2, alerts: 2, workHours: 2 });
    expect(await blobs.get(`${a}/a-retired-front`)).toBeNull();
    expect(await blobs.get(`${a}/a-active-front`)).not.toBeNull();
    const logs = await withTenant(db, a, (tx) => tx.select().from(schema.auditLogs));
    expect(logs.filter((l) => l.action === "person.purge").map((l) => [l.targetId, l.detail])).toEqual([
      [ids["A-ARCHIVED"], { retiredAt: "2019-12-31", retentionYears: 3 }],
      [ids["A-RETIRED"], { retiredAt: "2020-01-10", retentionYears: 3 }],
    ]);
    // 作成の記録(ID だけ)は残る
    expect(logs.some((l) => l.action === "person.create" && l.targetId === ids["A-RETIRED"])).toBe(true);
  });

  it("テナントごとの保存期間で判断し、他のテナントのデータには触れない", async () => {
    expect((await count(b)).persons).toEqual(["B-RETIRED"]);
    expect(await purgeExpired(db, blobs, at("2025-01-11"))).toEqual([expect.objectContaining({ tenantId: b, persons: 1 })]);
    expect(await count(b)).toEqual({ persons: [], cards: 0, images: 0, verifications: 0, alerts: 0, workHours: 0 });
    expect((await count(a)).persons).toEqual(["A-ACTIVE", "A-RECENT"]); // A-RECENT は 2025-06-02 から
  });

  it("画像ファイルを消せなくても行は消し、失敗の件数を返す", async () => {
    const failing = { ...blobs, put: blobs.put.bind(blobs), get: blobs.get.bind(blobs), delete: async () => Promise.reject(new Error("network")) };
    expect(await purgeExpired(db, failing, at("2025-06-02"))).toEqual([{ tenantId: a, persons: 1, cards: 1, images: 1, verifications: 1, blobFailures: 1 }]);
    expect((await count(a)).persons).toEqual(["A-ACTIVE"]);
  });

  it("在籍中の人はいつまでも消さない", async () => {
    expect(await purgeExpired(db, blobs, at("2099-01-01"))).toEqual([]);
    expect((await count(a)).persons).toEqual(["A-ACTIVE"]);
  });
});
