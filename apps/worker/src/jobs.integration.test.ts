/** アラート作成と通知送信(実際の PostgreSQL)。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import { createDb, schema, upsertPushToken, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAlerts, MAX_ATTEMPTS, sendNotifications } from "./jobs.js";
import { LogNotifier, type Notifier } from "./notifiers.js";

const url = process.env.TEST_DATABASE_URL;
const at = (jstDateTime: string) => Date.parse(`${jstDateTime}+09:00`);

describe.skipIf(!url)("アラートジョブ", () => {
  let db: Db;
  let end: () => Promise<void>;
  let tenant: string;
  let tokyo: string;
  let osaka: string;
  const u = { admin: "", tokyo: "", osaka: "", viewer: "" };

  const outbox = () => withTenant(db, tenant, (tx) => tx.select().from(schema.notificationOutbox));
  const addPerson = (siteId: string, code: string, expiryDate: string | null, extra: Partial<typeof schema.residenceCards.$inferInsert> = {}) =>
    withTenant(db, tenant, async (tx) => {
      const [p] = await tx.insert(schema.persons).values({ siteId, employeeCode: code, name: `氏名${code}` }).returning();
      await tx.insert(schema.residenceCards).values({
        personId: p!.id,
        cardFormat: "gen2",
        cardNumberEnc: randomBytes(8),
        cardNumberHmac: randomBytes(32),
        expiryDate,
        icVerified: true,
        ...extra,
      });
      return p!.id;
    });

  beforeAll(async () => {
    const c = createDb(await prepareTestDatabase(url!, "worker"), { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    tenant = await withPlatform(db, async (tx) => (await tx.insert(schema.tenants).values({ name: "A", status: "active" }).returning())[0]!.id);
    await withTenant(db, tenant, async (tx) => {
      const [t, o] = await tx.insert(schema.sites).values([{ name: "東京" }, { name: "大阪" }]).returning();
      tokyo = t!.id;
      osaka = o!.id;
      const mk = async (email: string, role: "tenant_admin" | "site_admin" | "viewer", site?: string, status: "active" | "suspended" = "active") => {
        const [x] = await tx.insert(schema.users).values({ email, role, status }).returning();
        if (site) await tx.insert(schema.userSites).values({ userId: x!.id, siteId: site });
        return x!.id;
      };
      u.admin = await mk("admin@example.com", "tenant_admin");
      u.tokyo = await mk("tokyo@example.com", "site_admin", tokyo);
      u.osaka = await mk("osaka@example.com", "site_admin", osaka);
      u.viewer = await mk("viewer@example.com", "viewer", tokyo);
      await mk("gone@example.com", "tenant_admin", undefined, "suspended");
    });
    await addPerson(tokyo, "T30", "2026-05-01"); // 4/1 時点で 30 日前
    await addPerson(tokyo, "T90", "2026-06-30"); // ちょうど 90 日前
    await addPerson(osaka, "O-EXP", "2026-03-31"); // 期限切れ
    await addPerson(osaka, "O-PENDING", "2026-04-10", { pendingApplication: true }); // 更新申請中は出さない
    await addPerson(osaka, "O-OK", "2027-01-01");
  });
  afterAll(async () => end?.());

  it("期限アラートを作り、受け取る人ごとに件数だけの通知を積む", async () => {
    const r = await generateAlerts(db, tenant, at("2026-04-01T00:30:00"));
    expect(r.created).toBe(3);
    const rows = await outbox();
    const byUser = (id: string) => rows.filter((n) => n.userId === id);
    // テナント管理者は全拠点、拠点管理者は担当拠点だけ、閲覧者・停止中のユーザーには送らない
    expect((byUser(u.admin)[0]!.payload as { body: string }).body).toBe("期限当日・期限切れ 1名、30日以内 1名、90日以内 1名。アプリで対象者を確認してください。");
    expect((byUser(u.tokyo)[0]!.payload as { body: string }).body).toBe("30日以内 1名、90日以内 1名。アプリで対象者を確認してください。");
    expect((byUser(u.osaka)[0]!.payload as { body: string }).body).toBe("期限当日・期限切れ 1名。アプリで対象者を確認してください。");
    expect(byUser(u.viewer)).toHaveLength(0);
    expect(rows.map((n) => n.channel).sort()).toEqual(["email", "email", "email", "push", "push", "push"]);
    // 通知に氏名は入らない
    expect(JSON.stringify(rows.map((n) => n.payload))).not.toContain("氏名");
  });

  it("同じ日にもう一度実行しても重複しない", async () => {
    const before = (await outbox()).length;
    expect((await generateAlerts(db, tenant, at("2026-04-01T12:00:00"))).created).toBe(0);
    expect((await outbox()).length).toBe(before);
  });

  it("次の段階になったら新しいアラートを作る", async () => {
    // T90 は 5/1 に 60 日前
    expect((await generateAlerts(db, tenant, at("2026-05-01T00:30:00"))).created).toBeGreaterThanOrEqual(1);
    const alerts = await withTenant(db, tenant, (tx) => tx.select().from(schema.alerts));
    expect(alerts.map((a) => a.type)).toContain("expiry_60");
  });

  it("送信: 端末未登録のプッシュはメールに任せて完了、メールは送る", async () => {
    const n = new LogNotifier();
    const r = await sendNotifications(db, tenant, n, at("2026-05-01T00:31:00"));
    expect(r.failed).toBe(0);
    const emailed = new Set(n.sent.filter((x) => x.channel === "email").map((x) => x.to));
    expect([...emailed].sort()).toEqual(["admin@example.com", "osaka@example.com", "tokyo@example.com"]);
    const rows = await outbox();
    expect(rows.every((x) => x.status === "sent")).toBe(true);
    expect(rows.filter((x) => x.channel === "push").every((x) => x.lastError === "no_device")).toBe(true);
  });

  it("失敗は間隔を空けて再送し、5 回で諦める。使えない端末トークンは消す", async () => {
    await withTenant(db, tenant, (tx) => upsertPushToken(tx, u.admin, "android", "ExponentPushToken[dead]"));
    await withTenant(db, tenant, async (tx) => {
      await tx.insert(schema.notificationOutbox).values([
        { userId: u.admin, channel: "email", payload: { title: "retry", body: "b", kind: "expiry_digest" }, nextAttemptAt: new Date(at("2026-06-01T00:00:00")) },
        { userId: u.admin, channel: "push", payload: { title: "retry", body: "b", kind: "expiry_digest" }, nextAttemptAt: new Date(at("2026-06-01T00:00:00")) },
      ]);
    });
    const failing: Notifier = {
      push: async () => ({ ok: true, invalidTokens: ["ExponentPushToken[dead]"] }),
      email: async () => ({ ok: false, error: "acs_Failed" }),
    };
    let now = at("2026-06-01T00:00:00");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sendNotifications(db, tenant, failing, now);
      now += 60 * 60_000; // 次の再送時刻を確実に過ぎる
    }
    const email = (await outbox()).find((x) => x.channel === "email" && (x.payload as { title: string }).title === "retry")!;
    expect(email).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "acs_Failed" });
    const devices = await withTenant(db, tenant, (tx) => tx.select().from(schema.userDevices).where(eq(schema.userDevices.userId, u.admin)));
    expect(devices).toHaveLength(0);
  });
});
