/** 失効情報照会(1-9)の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));

describe.skipIf(!url)("失効情報照会", () => {
  let h: Harness;
  let tenant: string;
  let tokyo: string;
  let osaka: string;
  let tokyoAdmin: AppCaller;
  let osakaAdmin: AppCaller;
  let viewer: AppCaller;
  let n = 0;

  /** 登録者を作り、IC なしでカードを登録して現在のカード ID を返す */
  async function personWithCard(manual: { expiryDate?: string; cardValidUntil?: string; statusOfResidence?: string } = { expiryDate: "2029-06-20" }) {
    n++;
    const { id: personId } = await tokyoAdmin.persons.create({ siteId: tokyo, employeeCode: `RV${n}`, name: `照会${n}` });
    const { cardId } = await tokyoAdmin.cards.register({
      personId,
      cardNumber: `AB${String(n).padStart(8, "0")}CD`,
      ic: null,
      icFailureReason: "other",
      manual,
    });
    return { personId, cardId };
  }

  beforeAll(async () => {
    h = await createHarness("api_revocation");
    h.clock.now = Date.parse("2026-04-01T03:00:00Z"); // JST 4/1 12:00
    tenant = await h.createTenant("A");
    tokyo = await h.createSite(tenant, "東京");
    osaka = await h.createSite(tenant, "大阪");
    await h.createUser(tenant, "admin@example.com", "tenant_admin");
    tokyoAdmin = await h.callerAs(tenant, await h.createUser(tenant, "tokyo@example.com", "site_admin", [tokyo]));
    osakaAdmin = await h.callerAs(tenant, await h.createUser(tenant, "osaka@example.com", "site_admin", [osaka]));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [tokyo]));
  });
  afterAll(async () => h?.end());

  it("照会用の番号と満了日を返し、番号の表示を監査ログに残す", async () => {
    const { cardId } = await personWithCard();
    const info = await tokyoAdmin.verifications.revocationCheckInfo({ cardId });
    expect(info).toEqual({ cardNumber: "AB00000001CD", validUntil: "2029-06-20", validUntilBasis: "stay" });
    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "card.reveal_number")));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("AB00000001CD");
  });

  it("永住者はカードの有効期限を返す", async () => {
    const { cardId } = await personWithCard({ statusOfResidence: "永住者", cardValidUntil: "2030-06-26" });
    expect(await tokyoAdmin.verifications.revocationCheckInfo({ cardId })).toMatchObject({ validUntil: "2030-06-26", validUntilBasis: "card" });
  });

  it("有効: 確認履歴に記録する", async () => {
    const { personId, cardId } = await personWithCard();
    expect(await tokyoAdmin.verifications.recordRevocationCheck({ cardId, result: "valid" })).toMatchObject({ recheckOn: null });
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.verifications.find((v) => v.method === "revocation_check")).toMatchObject({ result: "ok" });
    expect(card!.needsReview).toBe(false);
  });

  it("失効: 要確認にして、アラートと即時の通知を作る", async () => {
    const { personId, cardId } = await personWithCard();
    await tokyoAdmin.verifications.recordRevocationCheck({ cardId, result: "revoked", note: "失効と表示された" });
    const p = await tokyoAdmin.persons.get({ id: personId });
    expect(p.expiry.needsReview).toBe(true);
    const alerts = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.alerts).where(eq(schema.alerts.personId, personId)));
    expect(alerts.map((a) => a.type)).toEqual(["needs_review"]);
    const outbox = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox));
    expect(outbox.some((o) => (o.payload as { kind: string }).kind === "revoked")).toBe(true);
  });

  it("照会結果が出ない(交付当日): 翌日の再照会アラートと、翌朝 9 時の通知を作る", async () => {
    const { personId, cardId } = await personWithCard();
    const r = await tokyoAdmin.verifications.recordRevocationCheck({ cardId, result: "not_found" });
    expect(r.recheckOn).toBe("2026-04-02");
    const alerts = await withTenant(h.db, tenant, (tx) =>
      tx.select().from(schema.alerts).where(and(eq(schema.alerts.personId, personId), eq(schema.alerts.type, "recheck_revocation"))),
    );
    expect(alerts[0]?.dueDate).toBe("2026-04-02");
    const outbox = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.notificationOutbox));
    const recheck = outbox.filter((o) => (o.payload as { kind: string }).kind === "recheck_revocation");
    expect(recheck.length).toBeGreaterThan(0);
    expect(recheck.every((o) => o.nextAttemptAt.toISOString() === "2026-04-02T00:00:00.000Z")).toBe(true);
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.verifications.find((v) => v.method === "revocation_check")).toMatchObject({ result: "unverifiable" });
  });

  it("権限と範囲: 閲覧者は不可、担当外は見えない、以前のカードは照会しない", async () => {
    const { personId, cardId } = await personWithCard();
    expect(await codeOf(viewer.verifications.revocationCheckInfo({ cardId }))).toBe("FORBIDDEN");
    expect(await codeOf(osakaAdmin.verifications.revocationCheckInfo({ cardId }))).toBe("NOT_FOUND");
    await tokyoAdmin.cards.register({ personId, cardNumber: "AB99999999CD", ic: null, icFailureReason: "other", manual: { expiryDate: "2030-01-01" } });
    expect(await codeOf(tokyoAdmin.verifications.recordRevocationCheck({ cardId, result: "valid" }))).toBe("BAD_REQUEST");
  });
});
