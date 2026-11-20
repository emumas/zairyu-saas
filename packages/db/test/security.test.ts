/**
 * 実際の PostgreSQL でテナント分離・ロール別権限・追記専用を確かめる。
 * TEST_DATABASE_URL(スーパーユーザーまたはロール作成権限のあるユーザー)が無ければスキップする。
 * 同じサーバーに <DB名>_db を作って使う(public スキーマは毎回作り直す)。
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, lookupUserForLogin, withPlatform, withPurge, withTenant, type Db } from "../src/client.js";
import { prepareTestDatabase } from "../src/testing.js";
import { auditLogs, persons, residenceCards, sites, tenants, users, verifications } from "../src/schema.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("DB セキュリティ", () => {
  let db: Db;
  let end: () => Promise<void>;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let cardA: string;

  /** エラーの PostgreSQL の SQLSTATE を取り出す(drizzle が包むので cause もたどる) */
  async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      return err.code ?? err.cause?.code;
    }
  }

  beforeAll(async () => {
    const testUrl = await prepareTestDatabase(url!, "db");
    const c = createDb(testUrl, { max: 4 });
    db = c.db;
    end = () => c.pool.end();

    [tenantA, tenantB] = await withPlatform(db, async (tx) => {
      const rows = await tx.insert(tenants).values([{ name: "A社" }, { name: "B社" }]).returning({ id: tenants.id });
      return rows.map((r) => r.id) as [string, string];
    });

    // テナント ID を書かずに INSERT する(既定値がセッション変数から入る)
    for (const [t, label] of [[tenantA, "A"], [tenantB, "B"]] as const) {
      await withTenant(db, t, async (tx) => {
        const [site] = await tx.insert(sites).values({ name: `${label}拠点` }).returning();
        const [user] = await tx
          .insert(users)
          .values({ email: `admin-${label.toLowerCase()}@example.com`, role: "tenant_admin", status: "active", passwordHash: "x" })
          .returning();
        const [person] = await tx
          .insert(persons)
          .values({ siteId: site!.id, employeeCode: "E001", name: `${label}さん` })
          .returning();
        const [card] = await tx
          .insert(residenceCards)
          .values({ personId: person!.id, cardFormat: "gen2", cardNumberEnc: Buffer.from("enc"), cardNumberHmac: Buffer.from("h") })
          .returning();
        await tx.insert(verifications).values({ cardId: card!.id, method: "ic_signature", result: "ok", performedBy: user!.id });
        await tx.insert(auditLogs).values({ actorId: user!.id, action: "card.create" });
        if (label === "A") {
          userA = user!.id;
          cardA = card!.id;
        }
      });
    }
  });

  afterAll(async () => {
    await end?.();
  });

  describe("テナント分離(RLS)", () => {
    it("自テナントの行だけが見える", async () => {
      const names = await withTenant(db, tenantA, (tx) => tx.select({ name: persons.name }).from(persons));
      expect(names).toEqual([{ name: "Aさん" }]);
      const tenantRows = await withTenant(db, tenantA, (tx) => tx.select({ id: tenants.id }).from(tenants));
      expect(tenantRows).toEqual([{ id: tenantA }]);
    });

    it("INSERT した行には自テナントの ID が入る", async () => {
      const rows = await withTenant(db, tenantB, (tx) => tx.select({ t: sites.tenantId }).from(sites));
      expect(rows.every((r) => r.t === tenantB)).toBe(true);
    });

    it("他テナントの ID を明示して INSERT すると拒否される", async () => {
      const code = await pgCode(
        withTenant(db, tenantA, (tx) => tx.insert(sites).values({ tenantId: tenantB, name: "なりすまし" })),
      );
      expect(code).toBe("42501"); // RLS の WITH CHECK 違反
    });

    it("他テナントの行は UPDATE できない(0 件)", async () => {
      const updated = await withTenant(db, tenantA, (tx) =>
        tx.update(persons).set({ name: "改ざん" }).where(eq(persons.employeeCode, "E001")).returning(),
      );
      expect(updated).toHaveLength(1); // 自テナントの 1 件だけ
      const b = await withTenant(db, tenantB, (tx) => tx.select({ name: persons.name }).from(persons));
      expect(b).toEqual([{ name: "Bさん" }]);
    });

    it("テナント未設定では何も見えず、INSERT もできない", async () => {
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE zairyu_app`);
        return tx.select().from(persons);
      });
      expect(rows).toEqual([]);
      const code = await pgCode(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE zairyu_app`);
          await tx.insert(sites).values({ name: "x" });
        }),
      );
      expect(code).toBe("42501"); // tenant_id が NULL のため RLS の WITH CHECK で拒否
    });

    it("不正な形式のテナント ID は受け付けない", async () => {
      await expect(withTenant(db, "' OR 1=1 --", async () => 1)).rejects.toThrow();
    });

    it("tenant_id を持つテーブルはすべて RLS が有効で強制されている", async () => {
      const res = await db.execute<{ relname: string; rls: boolean; force: boolean }>(sql`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
               OR c.relname = 'tenants')`);
      expect(res.rows.length).toBeGreaterThanOrEqual(19);
      for (const r of res.rows) expect({ table: r.relname, rls: r.rls, force: r.force }).toEqual({ table: r.relname, rls: true, force: true });
    });
  });

  describe("zairyu_app の権限", () => {
    it("登録者は物理削除できない", async () => {
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.delete(persons)))).toBe("42501");
    });

    it("テナントの課金状態は変えられない(変えられるのは名前と保存期間だけ)", async () => {
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.update(tenants).set({ status: "active" })))).toBe("42501");
      await withTenant(db, tenantA, (tx) => tx.update(tenants).set({ retentionYears: 3 }));
    });

    it("保存期間は 3〜5 年", async () => {
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.update(tenants).set({ retentionYears: 6 })))).toBe("23514");
    });
  });

  describe("追記専用(確認履歴・監査ログ)", () => {
    it("アプリは UPDATE / DELETE できない", async () => {
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.update(verifications).set({ note: "x" })))).toBe("42501");
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.delete(verifications)))).toBe("42501");
      expect(await pgCode(withTenant(db, tenantA, (tx) => tx.update(auditLogs).set({ action: "x" })))).toBe("42501");
    });

    it("所有者(管理ユーザー)でもトリガーで拒否される", async () => {
      expect(await pgCode(db.update(verifications).set({ note: "x" }))).toBe("42501");
      expect(await pgCode(db.delete(auditLogs))).toBe("42501");
      expect(await pgCode(db.execute(sql`TRUNCATE verifications`))).toBe("42501");
    });

    it("削除ジョブのロールだけが DELETE できる", async () => {
      const deleted = await withPurge(db, (tx) => tx.delete(verifications).where(eq(verifications.cardId, cardA)).returning());
      expect(deleted).toHaveLength(1);
      // UPDATE は削除ジョブでも不可
      expect(await pgCode(withPurge(db, (tx) => tx.update(auditLogs).set({ action: "x" })))).toBe("42501");
    });
  });

  describe("運営者(zairyu_platform)", () => {
    it("全テナントを見られる", async () => {
      const rows = await withPlatform(db, (tx) => tx.select({ id: tenants.id }).from(tenants));
      expect(rows.map((r) => r.id).sort()).toEqual([tenantA, tenantB].sort());
    });

    it("登録者・カード・確認履歴には権限がない", async () => {
      expect(await pgCode(withPlatform(db, (tx) => tx.select().from(persons)))).toBe("42501");
      expect(await pgCode(withPlatform(db, (tx) => tx.select().from(residenceCards)))).toBe("42501");
      expect(await pgCode(withPlatform(db, (tx) => tx.select().from(verifications)))).toBe("42501");
    });

    it("ユーザーのパスワードハッシュは読めない", async () => {
      expect(await pgCode(withPlatform(db, (tx) => tx.select({ h: users.passwordHash }).from(users)))).toBe("42501");
      const rows = await withPlatform(db, (tx) => tx.select({ email: users.email }).from(users));
      expect(rows).toHaveLength(2);
    });
  });

  describe("ログイン用の検索", () => {
    it("テナント確定前にメールアドレスで引ける(大文字小文字を区別しない)", async () => {
      const u = await lookupUserForLogin(db, "ADMIN-A@example.com");
      expect(u).toMatchObject({ id: userA, tenant_id: tenantA, role: "tenant_admin" });
      expect(await lookupUserForLogin(db, "nobody@example.com")).toBeNull();
    });

    it("メールアドレスは全テナントで一意", async () => {
      const code = await pgCode(
        withTenant(db, tenantB, (tx) => tx.insert(users).values({ email: "Admin-A@example.com", role: "viewer" })),
      );
      expect(code).toBe("23505");
    });
  });
});
