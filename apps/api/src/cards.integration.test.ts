/** カード登録(1-7)の結合テスト。TEST_DATABASE_URL が無ければスキップ */
import { schema, withTenant } from "@zairyu/db";
import { toBase64, type EfPath } from "@zairyu/zairyu-ic";
import { buildCardFiles, makeCertAndKey, type FixtureOptions } from "@zairyu/zairyu-ic/testing";
import { decryptCardNumber, cardNumberHmac } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { serveImage } from "./images.js";
import { createHarness, type AppCaller, type Harness } from "./testHarness.js";

const url = process.env.TEST_DATABASE_URL;
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const NUMBER = "AB12345678CD";

describe.skipIf(!url)("カード登録", () => {
  let h: Harness;
  let tenant: string;
  let tokyo: string;
  let osaka: string;
  let admin: AppCaller;
  let tokyoAdmin: AppCaller;
  let osakaAdmin: AppCaller;
  let viewer: AppCaller;
  const ec = makeCertAndKey("ec");
  const rsa = makeCertAndKey("rsa");

  const icPayload = (o: Omit<FixtureOptions, "cardNumber"> & { cardNumber?: string }, tamper?: (f: Partial<Record<EfPath, Uint8Array>>) => void) => {
    const files = buildCardFiles({ cardNumber: NUMBER, ...o });
    tamper?.(files);
    const b64: Partial<Record<EfPath, string>> = {};
    for (const [k, v] of Object.entries(files)) if (v) b64[k as EfPath] = toBase64(v);
    return { format: o.format, kind: o.kind, files: b64 };
  };
  const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url)));
  const realImages = { front: fixture("g4.tif"), name: fixture("g4.tif"), face: fixture("face8.jp2") };
  let photoJpeg: Buffer;
  let photo: { contentType: "image/jpeg"; data: string };
  const newPerson = async (code: string, siteId = tokyo) => (await admin.persons.create({ siteId, employeeCode: code, name: code })).id;

  beforeAll(async () => {
    photoJpeg = await sharp({ create: { width: 32, height: 20, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    photo = { contentType: "image/jpeg", data: photoJpeg.toString("base64") };
    h = await createHarness("api_cards");
    h.clock.now = Date.parse("2026-04-01T03:00:00Z");
    tenant = await h.createTenant("A社");
    tokyo = await h.createSite(tenant, "東京");
    osaka = await h.createSite(tenant, "大阪");
    admin = await h.callerAs(tenant, await h.createUser(tenant, "admin@example.com", "tenant_admin"));
    tokyoAdmin = await h.callerAs(tenant, await h.createUser(tenant, "tokyo@example.com", "site_admin", [tokyo]));
    osakaAdmin = await h.callerAs(tenant, await h.createUser(tenant, "osaka@example.com", "site_admin", [osaka]));
    viewer = await h.callerAs(tenant, await h.createUser(tenant, "viewer@example.com", "viewer", [tokyo]));
  });
  afterAll(async () => h?.end());

  it("第2世代: 確認 → 登録。IC の値が保存され、署名検証済み・画像・確認履歴・監査ログが残る", async () => {
    const personId = await newPerson("G001");
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec, renewalApplying: false, images: realImages });
    const v = await tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: NUMBER, ic });
    // IC 内の画像(氏名・顔)が表示用に変換されて返る
    expect(v.icImages.map((i) => `${i.kind}:${i.contentType}`).sort()).toEqual(["ic_face:image/jpeg", "ic_name:image/png"]);
    expect(v).toMatchObject({ format: "gen2", icVerified: true, needsReview: false, diffs: [] });
    expect(v.signature).toMatchObject({ status: "valid", issuerTrusted: null });
    expect(v.fields).toMatchObject({ expiryDate: "2029-06-20", cardValidUntil: "2031-03-31", workRestriction: "2", statusOfResidence: "15" });

    const r = await tokyoAdmin.cards.register({ personId, cardNumber: NUMBER, ic, photos: { front: photo }, deviceId: "dev-1" });
    expect(r).toMatchObject({ icVerified: true, needsReview: false });

    const p = await tokyoAdmin.persons.get({ id: personId });
    expect(p.card).toMatchObject({ id: r.cardId, cardFormat: "gen2", expiryDate: "2029-06-20", icVerified: true });
    expect(p.expiry.bucket).toBe("ok");

    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.images.map((i) => i.kind).sort()).toEqual(["front", "ic_address", "ic_face", "ic_name"]);
    expect(card!.verifications.map((x) => `${x.method}:${x.result}`).sort()).toEqual(["ic_signature:ok", "visual:ok"]);

    // カード番号は暗号化され、HMAC で引ける
    const row = await withTenant(h.db, tenant, async (tx) => (await tx.select().from(schema.residenceCards).where(eq(schema.residenceCards.id, r.cardId)))[0]!);
    expect(row.cardNumberEnc.includes(Buffer.from(NUMBER))).toBe(false);
    expect(await decryptCardNumber(h.services.vault!.keyring, tenant, row.cardNumberEnc)).toBe(NUMBER);
    expect(row.cardNumberHmac.equals(await cardNumberHmac(h.services.vault!.keyring, tenant, NUMBER))).toBe(true);

    // 撮影画像を取り出せる(URL)
    const frontId = card!.images.find((i) => i.kind === "front")!.id;
    const { url: u } = await tokyoAdmin.cards.getImageUrl({ imageId: frontId });
    const served = await serveImage(h.services, u.split("/files/images/")[1]!);
    expect(served.body.equals(photoJpeg)).toBe(true);
    // IC の顔画像(JPEG2000)・氏名イメージ(TIFF)は表示用に変換してデータで返す
    const faceId = card!.images.find((i) => i.kind === "ic_face")!.id;
    const face = await tokyoAdmin.cards.getImage({ imageId: faceId });
    expect(face).toMatchObject({ kind: "ic_face", contentType: "image/jpeg", width: 160, height: 200 });
    const nameImg = await tokyoAdmin.cards.getImage({ imageId: card!.images.find((i) => i.kind === "ic_name")!.id });
    expect(nameImg).toMatchObject({ contentType: "image/png", width: 600, height: 380 });
    const viewLogs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, faceId)));
    expect(viewLogs.map((l) => l.action)).toEqual(["card_image.view"]);

    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, r.cardId)));
    expect(logs.map((l) => l.action)).toContain("card.register");
    expect(JSON.stringify(logs)).not.toContain(NUMBER);
  });

  it("券面の入力と IC が食い違うと理由が必要で、理由付きなら mismatch として残る", async () => {
    const personId = await newPerson("G002");
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec });
    const manual = { expiryDate: "2029-06-21" };
    const v = await tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: NUMBER.replace("CD", "CE"), ic, manual });
    expect(v.diffs.map((d) => d.field).sort()).toEqual(["cardNumber", "expiryDate"]);
    expect(v.diffs.find((d) => d.field === "cardNumber")).toEqual({ field: "cardNumber", ic: null, input: null });

    expect(await codeOf(tokyoAdmin.cards.register({ personId, cardNumber: "AB12345679CD", ic, manual }))).toBe("BAD_REQUEST");
    const r = await tokyoAdmin.cards.register({ personId, cardNumber: "AB12345679CD", ic, manual, diffReason: "券面の満了日を読み違えた" });
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.expiryDate).toBe("2029-06-20"); // IC の値が優先
    expect(card!.verifications.find((x) => x.method === "visual")).toMatchObject({ result: "mismatch", note: "券面の満了日を読み違えた" });
    expect(r.diffs).toHaveLength(2);
  });

  it("署名が改ざんされていれば要確認(偽造の疑い)として保存する", async () => {
    const personId = await newPerson("G003");
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB00000003CD" }, (f) => {
      f["df1/ef02"]![5]! ^= 1; // 券面記載事項を 1 バイト改ざん
    });
    const r = await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000003CD", ic });
    expect(r).toMatchObject({ icVerified: false, needsReview: true });
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.verifications.find((x) => x.method === "ic_signature")?.result).toBe("failed");
    expect((await tokyoAdmin.persons.get({ id: personId })).expiry.needsReview).toBe(true);
  });

  it("旧様式: IC に文字情報がないので満了日などは入力値。署名なしのカードは検証不可", async () => {
    const personId = await newPerson("L001");
    const ic = icPayload({ format: "legacy", kind: "residence", renewalApplying: true });
    const r = await tokyoAdmin.cards.register({
      personId,
      cardNumber: "AB00000004CD",
      ic,
      manual: { expiryDate: "2026-04-20", workRestriction: "1", statusOfResidence: "技術・人文知識・国際業務" },
    });
    expect(r).toMatchObject({ icVerified: false, needsReview: false });
    const p = await tokyoAdmin.persons.get({ id: personId });
    expect(p.card).toMatchObject({ cardFormat: "legacy", expiryDate: "2026-04-20", workRestriction: "1", pendingApplication: true });
    expect(p.expiry.bucket).toBe("pending");
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.verifications.find((x) => x.method === "ic_signature")?.result).toBe("unverifiable");
  });

  it("旧様式の永住者: 在留期間満了日の入力は拒否し、カードの有効期限で期限を管理する", async () => {
    const personId = await newPerson("L003");
    const ic = icPayload({ format: "legacy", kind: "residence", signer: rsa, renewalApplying: false });
    expect(
      await codeOf(tokyoAdmin.cards.register({ personId, cardNumber: "AB00000011CD", ic, manual: { statusOfResidence: "永住者", expiryDate: "2030-06-26" } })),
    ).toBe("BAD_REQUEST");
    await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000011CD", ic, manual: { statusOfResidence: "永住者", cardValidUntil: "2030-06-26", workRestriction: "1" } });
    const p = await tokyoAdmin.persons.get({ id: personId });
    expect(p.card).toMatchObject({ expiryDate: null, cardValidUntil: "2030-06-26" });
    expect(p.expiry).toMatchObject({ bucket: "ok", deadlineBasis: "card", deadline: "2030-06-26" });
  });

  it("旧様式: RSA 署名付きなら検証済み。券面イメージ(TIFF)と顔画像(JPEG2000)を表示できる", async () => {
    const personId = await newPerson("L002");
    const ic = icPayload({ format: "legacy", kind: "residence", signer: rsa, images: { front: realImages.front, face: realImages.face } });
    const v = await tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: "AB00000005CD", ic });
    expect(v.icImages.map((i) => i.kind).sort()).toEqual(["ic_face", "ic_front"]);
    const r = await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000005CD", ic, manual: { expiryDate: "2030-01-01" } });
    expect(r.icVerified).toBe(true);
  });

  it("IC が読めなければ理由が必要で、IC 未検証として登録される", async () => {
    const personId = await newPerson("N001");
    expect(await codeOf(tokyoAdmin.cards.register({ personId, cardNumber: "AB00000006CD", ic: null }))).toBe("BAD_REQUEST");
    await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000006CD", ic: null, icFailureReason: "unreadable", manual: { expiryDate: "2027-01-01" } });
    const p = await tokyoAdmin.persons.get({ id: personId });
    expect(p.expiry).toMatchObject({ bucket: "ok", icUnverified: true });
    const [card] = await tokyoAdmin.cards.listForPerson({ personId });
    expect(card!.verifications).toEqual([expect.objectContaining({ method: "visual", result: "ok", note: "IC 読取不可: unreadable" })]);
  });

  it("再登録すると以前のカードは履歴に残る", async () => {
    const personId = await newPerson("R001");
    await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000007CD", ic: null, icFailureReason: "other" });
    await tokyoAdmin.cards.register({ personId, cardNumber: "AB00000008CD", ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB00000008CD" }) });
    const cards = await tokyoAdmin.cards.listForPerson({ personId });
    expect(cards.map((c) => c.isCurrent)).toEqual([true, false]);
  });

  it("同じ番号が別の登録者に登録されていれば CONFLICT", async () => {
    const a = await newPerson("D001");
    const b = await newPerson("D002");
    await tokyoAdmin.cards.register({ personId: a, cardNumber: "AB00000009CD", ic: null, icFailureReason: "other" });
    expect(await codeOf(tokyoAdmin.cards.register({ personId: b, cardNumber: "AB00000009CD", ic: null, icFailureReason: "other" }))).toBe("CONFLICT");
  });

  it("閲覧者はカード画像を見られない", async () => {
    const [card] = await admin.cards.listForPerson({ personId: (await admin.persons.list({ q: "G001" })).items[0]!.id });
    expect(await codeOf(viewer.cards.getImage({ imageId: card!.images[0]!.id }))).toBe("FORBIDDEN");
  });

  it("権限と拠点の範囲", async () => {
    const personId = await newPerson("P001");
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec });
    expect(await codeOf(viewer.cards.register({ personId, cardNumber: NUMBER, ic }))).toBe("FORBIDDEN");
    expect(await codeOf(viewer.cards.listForPerson({ personId }))).toBe("FORBIDDEN");
    expect(await codeOf(osakaAdmin.cards.verifyIcRead({ personId, cardNumber: NUMBER, ic }))).toBe("NOT_FOUND");
    expect(await codeOf(osakaAdmin.cards.listForPerson({ personId }))).toBe("NOT_FOUND");
  });

  it("退職者にはカードを登録できない", async () => {
    const personId = await newPerson("X001");
    await admin.persons.retire({ id: personId });
    expect(await codeOf(admin.cards.register({ personId, cardNumber: "AB00000010CD", ic: null, icFailureReason: "other" }))).toBe("BAD_REQUEST");
  });

  it("壊れた IC データは BAD_REQUEST", async () => {
    const personId = await newPerson("B001");
    const ic = { format: "gen2" as const, kind: "residence" as const, files: { "df1/ef02": Buffer.from([0xc5, 0x20]).toString("base64") } };
    expect(await codeOf(tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: NUMBER, ic }))).toBe("BAD_REQUEST");
  });
});
