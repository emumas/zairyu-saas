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
import { trustedIssuers } from "./trust.js";

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

  it("新しい登録者: 登録者を作る前にカードを照合できる(同じカードの登録者も返す)。その後に作った登録者へ登録できる", async () => {
    const n = "NW12345678CD";
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n });
    const v = await tokyoAdmin.cards.verifyIcRead({ cardNumber: n, ic });
    expect(v).toMatchObject({ format: "gen2", icVerified: true, sameCard: [] });
    const { id } = await tokyoAdmin.persons.create({ siteId: tokyo, employeeCode: "NW01", name: "NEW PERSON" });
    await tokyoAdmin.cards.register({ personId: id, cardNumber: n, ic });
    // 同じカードでもう一度「新しい登録者」として照合すると、登録済みの人が出る
    expect((await tokyoAdmin.cards.verifyIcRead({ cardNumber: n, ic })).sameCard).toMatchObject([{ personId: id, status: "active" }]);
    expect(await codeOf(viewer.cards.verifyIcRead({ cardNumber: n, ic }))).toBe("FORBIDDEN");
  });

  it("写真の撮り直し: 同じ種類の古い写真を消して差し替える(IC の画像は残す)。現在のカード・在籍者・編集できる人だけ", async () => {
    const personId = await newPerson("PH01");
    const n = "PH12345678CD";
    const ic = icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n, images: realImages });
    const { cardId } = await tokyoAdmin.cards.register({ personId, cardNumber: n, ic, photos: { front: photo } });
    const before = (await tokyoAdmin.cards.listForPerson({ personId }))[0]!.images;
    const oldFront = before.find((i) => i.kind === "front")!;
    const oldBlob = (await withTenant(h.db, tenant, (tx) => tx.select().from(schema.cardImages).where(eq(schema.cardImages.id, oldFront.id))))[0]!.blobKey;

    const png = { contentType: "image/png" as const, data: Buffer.from("new-back").toString("base64") };
    expect(await tokyoAdmin.cards.replacePhotos({ cardId, front: photo, back: png })).toEqual({ replaced: ["front", "back"] });
    const after = (await tokyoAdmin.cards.listForPerson({ personId }))[0]!.images;
    expect(after.map((i) => i.kind).sort()).toEqual(["back", "front", "ic_address", "ic_face", "ic_name"]);
    expect(after.find((i) => i.kind === "front")!.id).not.toBe(oldFront.id);
    // 古い写真のファイルも消える
    expect(await h.services.vault!.blobs.get(oldBlob)).toBeNull();
    const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "card.photo_replace")));
    expect(logs.at(-1)).toMatchObject({ targetId: cardId, detail: { kinds: ["front", "back"], removed: 1 } });

    expect(await codeOf(tokyoAdmin.cards.replacePhotos({ cardId } as never))).toBe("BAD_REQUEST");
    expect(await codeOf(viewer.cards.replacePhotos({ cardId, front: photo }))).toBe("FORBIDDEN");
    expect(await codeOf(osakaAdmin.cards.replacePhotos({ cardId, front: photo }))).toBe("NOT_FOUND");
    await admin.persons.retire({ id: personId, reasonCode: "self" });
    expect(await codeOf(tokyoAdmin.cards.replacePhotos({ cardId, front: photo }))).toBe("BAD_REQUEST");
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

  describe("IC 再検証(1-8)", () => {
    it("読み直して確認履歴に追記し、IC に追記された更新申請中を反映する", async () => {
      const personId = await newPerson("RV01");
      const { cardId } = await tokyoAdmin.cards.register({
        personId,
        cardNumber: "AB10000001CD",
        ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000001CD", renewalApplying: false }),
      });
      const start = await tokyoAdmin.cards.reverifyStart({ cardId });
      expect(start).toEqual({ cardNumber: "AB10000001CD", cardFormat: "gen2" });

      // 更新を申請した後のカード(IC に「申請中」が追記されている)
      const r = await tokyoAdmin.cards.reverifyIc({
        cardId,
        ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000001CD", renewalApplying: true }),
      });
      expect(r).toMatchObject({ signature: "valid", icVerified: true, needsReview: false });
      expect(r.changes).toEqual([{ field: "pendingApplication", before: false, after: true }]);
      const p = await tokyoAdmin.persons.get({ id: personId });
      expect(p.card?.pendingApplication).toBe(true);
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      expect(card!.verifications.filter((v) => v.method === "ic_signature")).toHaveLength(2);
    });

    it("別のカードを読んだら拒否する", async () => {
      const personId = await newPerson("RV02");
      const { cardId } = await tokyoAdmin.cards.register({
        personId,
        cardNumber: "AB10000002CD",
        ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000002CD" }),
      });
      const other = icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000099CD" });
      expect(await codeOf(tokyoAdmin.cards.reverifyIc({ cardId, ic: other }))).toBe("BAD_REQUEST");
      const legacy = icPayload({ format: "legacy", kind: "residence", signer: rsa });
      expect(await codeOf(tokyoAdmin.cards.reverifyIc({ cardId, ic: legacy }))).toBe("BAD_REQUEST");
    });

    it("署名が NG なら要確認にし、IC の内容では更新しない", async () => {
      const personId = await newPerson("RV03");
      const { cardId } = await tokyoAdmin.cards.register({
        personId,
        cardNumber: "AB10000003CD",
        ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000003CD", renewalApplying: false }),
      });
      const tampered = icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: "AB10000003CD", renewalApplying: true }, (f) => {
        f["df1/ef02"]![5]! ^= 1;
      });
      const r = await tokyoAdmin.cards.reverifyIc({ cardId, ic: tampered });
      expect(r).toMatchObject({ signature: "invalid", icVerified: false, needsReview: true, changes: [] });
      const p = await tokyoAdmin.persons.get({ id: personId });
      expect(p.card).toMatchObject({ pendingApplication: false, icVerified: false, needsReview: true });
    });

    it("閲覧者・担当外は再検証できない", async () => {
      const personId = await newPerson("RV04");
      const { cardId } = await tokyoAdmin.cards.register({ personId, cardNumber: "AB10000004CD", ic: null, icFailureReason: "other" });
      expect(await codeOf(viewer.cards.reverifyStart({ cardId }))).toBe("FORBIDDEN");
      expect(await codeOf(osakaAdmin.cards.reverifyStart({ cardId }))).toBe("NOT_FOUND");
    });
  });

  describe("発行者証明書(入管庁 ZairyuCard CA)", () => {
    afterAll(() => {
      h.services.config.trustedIssuers = [];
    });

    it("本物の CA(旧様式 RSA・第2世代 ECDSA)で発行されていない証明書は要確認(偽造の疑い)", async () => {
      h.services.config.trustedIssuers = trustedIssuers({});
      const legacyPerson = await newPerson("CA1");
      const n1 = "AJ12345678CD";
      const r1 = await tokyoAdmin.cards.register({ personId: legacyPerson, cardNumber: n1, ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n1 }), manual: { expiryDate: "2029-06-20" } });
      expect(r1).toMatchObject({ icVerified: false, needsReview: true });

      const gen2Person = await newPerson("CA2");
      const n2 = "AK12345678CD";
      const v = await tokyoAdmin.cards.verifyIcRead({ personId: gen2Person, cardNumber: n2, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n2 }), manual: {} });
      expect(v.signature).toMatchObject({ status: "valid", issuerTrusted: false });
      expect(v).toMatchObject({ icVerified: false, needsReview: true });
    });
  });

  describe("住居地とカード記載事項", () => {
    it("旧様式: 裏面に住居地の追記があれば、端末の読み取りより IC の値を採用する", async () => {
      const personId = await newPerson("ADDR1");
      const verify = await tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: "AD12345678CD", ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: "AD12345678CD", backAddress: { address: "埼玉県さいたま市浦和区高砂3-15-1", writtenAt: "20251005" } }), manual: {} });
      expect(verify.icBackAddress).toEqual({ address: "埼玉県さいたま市浦和区高砂3-15-1", writtenAt: "2025-10-05" });
      await tokyoAdmin.cards.register({
        personId,
        cardNumber: "AD12345678CD",
        ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: "AD12345678CD", backAddress: { address: "埼玉県さいたま市浦和区高砂3-15-1", writtenAt: "20251005" } }),
        manual: { expiryDate: "2029-06-20", address: "東京都新宿区西新宿2-8-1", addressSource: "front_photo", birthDate: "1995-04-01", sex: "M", nationality: "ベトナム" },
      });
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      expect(card).toMatchObject({
        address: "埼玉県さいたま市浦和区高砂3-15-1",
        addressSource: "ic_back",
        addressWrittenAt: "2025-10-05",
        birthDate: "1995-04-01",
        sex: "M",
        nationality: "ベトナム",
        cardNumberMasked: "AD******78CD",
      });
      // 暗号化して保存している(平文で DB に残らない)
      const [row] = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.residenceCards).where(eq(schema.residenceCards.id, card!.id)));
      expect(row!.addressEnc!.toString("utf8")).not.toContain("さいたま");
      // 監査ログには出どころだけ
      const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, card!.id)));
      expect(JSON.stringify(logs)).not.toContain("さいたま");
      expect(logs.find((l) => l.action === "card.register")?.detail).toMatchObject({ addressSource: "ic_back" });
      // 登録者の生年月日は空欄だったのでカードの値で埋まる(国籍はコードでないので埋めない)
      expect((await admin.persons.get({ id: personId })).birthDate).toBe("1995-04-01");
    });

    it("申告書の入力用に、在籍者の氏名・フリガナ・郵便番号・住居地を出力できる(テナント管理者のみ。監査ログに件数だけ)", async () => {
      const { rows } = await admin.reports.declarationBasics();
      expect(rows.find((r) => r.employeeCode === "ADDR1")).toMatchObject({ name: "ADDR1", nameKana: null, birthDate: "1995-04-01", siteName: expect.any(String), address: "埼玉県さいたま市浦和区高砂3-15-1" });
      // カードの無い在籍者も出す(住所は空)
      expect(rows.find((r) => r.address === null)).toBeTruthy();
      await expect(tokyoAdmin.reports.declarationBasics()).rejects.toThrow();
      await expect(viewer.reports.declarationBasics()).rejects.toThrow();
      const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "report.declaration_basics_export")));
      expect(logs.at(-1)?.detail).toMatchObject({ count: rows.length });
      expect(JSON.stringify(logs)).not.toContain("さいたま");
    });

    it("裏面の追記が無ければ、端末の読み取り(裏面 > 表面)の値を使う", async () => {
      const personId = await newPerson("ADDR2");
      const n = "AE12345678CD";
      await tokyoAdmin.cards.register({
        personId,
        cardNumber: n,
        ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n, backAddress: null }),
        manual: { expiryDate: "2029-06-20", address: "神奈川県横浜市中区本町1-1", addressSource: "back_photo" },
      });
      expect((await tokyoAdmin.cards.listForPerson({ personId }))[0]).toMatchObject({ address: "神奈川県横浜市中区本町1-1", addressSource: "back_photo", addressWrittenAt: null });
    });

    it("第2世代: 生年月日・性別・国籍は IC の値", async () => {
      const personId = await newPerson("ADDR3");
      const n = "AF12345678CD";
      await tokyoAdmin.cards.register({ personId, cardNumber: n, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n }), manual: {} });
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      expect(card!.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(card!.nationality).toMatch(/^[A-Z]{3}$/);
    });

    it("番号の全桁表示は監査ログに残る。閲覧者・担当外は見られない", async () => {
      const personId = await newPerson("ADDR4");
      const n = "AG12345678CD";
      await tokyoAdmin.cards.register({ personId, cardNumber: n, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n }), manual: {} });
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      expect(await tokyoAdmin.cards.revealCardNumber({ cardId: card!.id })).toEqual({ cardNumber: n });
      const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "card.reveal_number")));
      expect(logs.some((l) => l.targetId === card!.id && (l.detail as { purpose: string }).purpose === "view")).toBe(true);
      expect(await codeOf(viewer.cards.revealCardNumber({ cardId: card!.id }))).toBe("FORBIDDEN");
      expect(await codeOf(osakaAdmin.cards.revealCardNumber({ cardId: card!.id }))).toBe("NOT_FOUND");
      expect(await codeOf(viewer.cards.listForPerson({ personId }))).toBe("FORBIDDEN");
    });

    it("保存済みの写真の読み取り結果などで記載事項を直せる(旧様式)。変更した項目名を監査ログと確認履歴に残す", async () => {
      const personId = await newPerson("UPD1");
      const n = "AM12345678CD";
      await tokyoAdmin.cards.register({ personId, cardNumber: n, ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n, backAddress: null }), manual: { expiryDate: "2029-06-20", statusOfResidence: "技術" } });
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      const r = await tokyoAdmin.cards.updateDetails({
        cardId: card!.id,
        birthDate: "1990-02-03",
        sex: "F",
        nationality: "フィリピン",
        address: "愛知県名古屋市中区栄1-1",
        addressSource: "back_photo",
        statusOfResidence: "技術・人文知識・国際業務",
        expiryDate: "2029-06-20", // 同じ値は変更に数えない
      });
      expect(r.changed.sort()).toEqual(["address", "birthDate", "nationality", "sex", "statusOfResidence"]);
      const [after] = await tokyoAdmin.cards.listForPerson({ personId });
      expect(after).toMatchObject({ birthDate: "1990-02-03", sex: "F", nationality: "フィリピン", address: "愛知県名古屋市中区栄1-1", addressSource: "back_photo", statusOfResidence: "技術・人文知識・国際業務" });
      expect(after!.verifications.some((v) => v.method === "visual" && v.note === "記載事項の修正")).toBe(true);
      const logs = await withTenant(h.db, tenant, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "card.update_details")));
      expect(JSON.stringify(logs)).not.toContain("名古屋");
      expect(await codeOf(tokyoAdmin.cards.updateDetails({ cardId: card!.id, sex: "F" }))).toBe("BAD_REQUEST"); // 変更なし
      // 永住者に満了日は入れられない
      expect(await codeOf(tokyoAdmin.cards.updateDetails({ cardId: card!.id, statusOfResidence: "永住者" }))).toBe("BAD_REQUEST");
      // 権限と範囲
      expect(await codeOf(viewer.cards.updateDetails({ cardId: card!.id, sex: "M" }))).toBe("FORBIDDEN");
      expect(await codeOf(osakaAdmin.cards.updateDetails({ cardId: card!.id, sex: "M" }))).toBe("NOT_FOUND");
    });

    it("IC の値(第2世代の記載事項・IC の裏面追記の住居地)は直せない", async () => {
      const gen2Person = await newPerson("UPD2");
      const n2 = "AN12345678CD";
      await tokyoAdmin.cards.register({ personId: gen2Person, cardNumber: n2, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n2 }), manual: {} });
      const [g] = await tokyoAdmin.cards.listForPerson({ personId: gen2Person });
      expect(await codeOf(tokyoAdmin.cards.updateDetails({ cardId: g!.id, birthDate: "2000-01-01" }))).toBe("BAD_REQUEST");
      expect((await tokyoAdmin.cards.updateDetails({ cardId: g!.id, address: "京都府京都市下京区1-1", addressSource: "front_photo" })).changed).toEqual(["address"]);

      const legacyPerson = await newPerson("UPD3");
      const n3 = "AP12345678CD";
      await tokyoAdmin.cards.register({ personId: legacyPerson, cardNumber: n3, ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n3 }), manual: { expiryDate: "2029-06-20" } });
      const [l] = await tokyoAdmin.cards.listForPerson({ personId: legacyPerson });
      expect(l!.addressSource).toBe("ic_back");
      expect(await codeOf(tokyoAdmin.cards.updateDetails({ cardId: l!.id, address: "x県" }))).toBe("BAD_REQUEST");
    });

    it("再検証で裏面に新しい住居地が追記されていれば更新する(変更の記録に値は残さない)", async () => {
      const personId = await newPerson("ADDR5");
      const n = "AH12345678CD";
      await tokyoAdmin.cards.register({ personId, cardNumber: n, ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n, backAddress: null }), manual: { expiryDate: "2029-06-20", address: "東京都新宿区1-1", addressSource: "front_photo" } });
      const [card] = await tokyoAdmin.cards.listForPerson({ personId });
      const r = await tokyoAdmin.cards.reverifyIc({ cardId: card!.id, ic: icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: n, backAddress: { address: "千葉県千葉市中央区1-1", writtenAt: "20260301" } }) });
      expect(r.changes).toContainEqual({ field: "address", before: null, after: null });
      expect((await tokyoAdmin.cards.listForPerson({ personId }))[0]).toMatchObject({ address: "千葉県千葉市中央区1-1", addressSource: "ic_back", addressWrittenAt: "2026-03-01" });
    });
  });

  describe("カード番号による同一人物の確認", () => {
    it("退職者のカード(過去のカードも)と同じ番号なら、前回の退職理由を示して再入社に誘導する", async () => {
      const old = await newPerson("SC1");
      const n = "AR12345678CD";
      const legacy = (num: string) => icPayload({ format: "legacy", kind: "residence", signer: rsa, cardNumber: num, backAddress: null });
      await tokyoAdmin.cards.register({ personId: old, cardNumber: n, ic: legacy(n), manual: { expiryDate: "2029-06-20" } });
      // 後でカードが更新され、n は過去のカードになった
      const n2 = "AS12345678CD";
      await tokyoAdmin.cards.register({ personId: old, cardNumber: n2, ic: legacy(n2), manual: { expiryDate: "2032-06-20" } });
      await tokyoAdmin.persons.retire({ id: old, retiredAt: "2026-03-31", reasonCode: "self", reasonNote: "帰国のため" });

      const fresh = await newPerson("SC2");
      const v = await tokyoAdmin.cards.verifyIcRead({ personId: fresh, cardNumber: n, ic: legacy(n), manual: {} });
      expect(v.sameCard).toEqual([
        { personId: old, employeeCode: "SC1", name: "SC1", siteName: "東京", status: "retired", retiredAt: "2026-03-31", isCurrentCard: false, lastEmployment: { retiredAt: "2026-03-31", reasonCode: "self", reasonNote: "帰国のため" } },
      ]);
      const err = await tokyoAdmin.cards.register({ personId: fresh, cardNumber: n, ic: legacy(n), manual: { expiryDate: "2029-06-20" } }).catch((e: TRPCError) => e);
      expect(err).toMatchObject({ code: "CONFLICT" });
      expect((err as TRPCError).message).toContain("再入社");
      expect((err as TRPCError).message).toContain("帰国のため");
      // 担当外の拠点の人は社員番号と拠点名だけ
      const osakaPerson = await newPerson("SC3", osaka);
      const fromOsaka = await osakaAdmin.cards.verifyIcRead({ personId: osakaPerson, cardNumber: n, ic: legacy(n), manual: {} });
      expect(fromOsaka.sameCard[0]).toMatchObject({ personId: null, name: null, employeeCode: "SC1", lastEmployment: null });
      // 再入社すれば、元の登録者には登録できる
      await tokyoAdmin.persons.reactivate({ id: old });
      await tokyoAdmin.cards.register({ personId: old, cardNumber: n2, ic: legacy(n2), manual: { expiryDate: "2032-06-20" } });
    });

    it("在籍中の別の登録者の過去のカードと同じ番号でも二重登録として止める。アーカイブ済みは止めない", async () => {
      const a = await newPerson("SC4");
      const n = "AT12345678CD";
      await tokyoAdmin.cards.register({ personId: a, cardNumber: n, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n }), manual: {} });
      const n2 = "AU12345678CD";
      await tokyoAdmin.cards.register({ personId: a, cardNumber: n2, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n2 }), manual: {} });
      const b = await newPerson("SC5");
      const err = await tokyoAdmin.cards.register({ personId: b, cardNumber: n, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n }), manual: {} }).catch((e: TRPCError) => e);
      expect((err as TRPCError).message).toContain("二重登録の疑い");

      await admin.persons.archive({ id: a });
      await tokyoAdmin.cards.register({ personId: b, cardNumber: n2, ic: icPayload({ format: "gen2", kind: "residence", signer: ec, cardNumber: n2 }), manual: {} });
    });
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
    await admin.persons.retire({ id: personId, reasonCode: "self" });
    expect(await codeOf(admin.cards.register({ personId, cardNumber: "AB00000010CD", ic: null, icFailureReason: "other" }))).toBe("BAD_REQUEST");
  });

  it("壊れた IC データは BAD_REQUEST", async () => {
    const personId = await newPerson("B001");
    const ic = { format: "gen2" as const, kind: "residence" as const, files: { "df1/ef02": Buffer.from([0xc5, 0x20]).toString("base64") } };
    expect(await codeOf(tokyoAdmin.cards.verifyIcRead({ personId, cardNumber: NUMBER, ic }))).toBe("BAD_REQUEST");
  });
});
