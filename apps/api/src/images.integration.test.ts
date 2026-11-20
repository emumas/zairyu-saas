/** カード画像の URL 発行と配信(実際の PostgreSQL)。TEST_DATABASE_URL が無ければスキップ */
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { createDb, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { encryptCardNumber, cardNumberHmac, LocalKeyProvider, MemoryBlobStore, putEncryptedBlob, TenantKeyring } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalSecretBox } from "./auth/secretBox.js";
import { AuthService } from "./auth/service.js";
import { signToken } from "./auth/tokens.js";
import type { Config } from "./config.js";
import { serveImage } from "./images.js";
import { RateLimiter } from "./rateLimit.js";
import { appRouter } from "./router.js";
import { createCallerFactory, type Services } from "./trpc.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("カード画像の配信", () => {
  let db: Db;
  let end: () => Promise<void>;
  let services: Services;
  let blobs: MemoryBlobStore;
  let clock = 1_900_000_000_000;
  let tenantId: string;
  let imageId: string;
  let image: Buffer;
  const users: Record<"admin" | "tokyo" | "osaka" | "viewer", string> = { admin: "", tokyo: "", osaka: "", viewer: "" };

  const config: Config = {
    databaseUrl: undefined,
    jwtSecret: new TextEncoder().encode("image-test-secret-".repeat(3)),
    secretBoxKey: randomBytes(32),
    totpIssuer: "t",
    publicBaseUrl: "https://api.example.com",
    webBaseUrl: "https://web.example.com",
    invitationTtlSec: 72 * 3600,
    imageUrlTtlSec: 120,
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 3600,
    purposeTokenTtlSec: 300,
    maxFailedLogins: 10,
    lockoutSec: 900,
    passwordResetTtlSec: 3600,
    // 既定は発行者の判定なし(テスト用の証明書で署名するため)。判定は cards.integration.test.ts で本物の CA を使って確かめる
    trustedIssuers: [],
  };

  /** ログイン手順は auth.integration.test.ts で確かめているので、ここではアクセストークンを直接作る */
  const as = async (who: keyof typeof users) => {
    const token = await signToken(config.jwtSecret, { userId: users[who], tenantId, type: "access" }, 900, Math.floor(clock / 1000));
    return createCallerFactory(appRouter)({ requestId: "t", services, accessToken: token, ip: "10.0.0.1" });
  };
  const tokenOf = (u: string) => u.split("/files/images/")[1]!;

  beforeAll(async () => {
    image = await sharp({ create: { width: 40, height: 25, channels: 3, background: "#cc3366" } }).jpeg().toBuffer();
    const c = createDb(await prepareTestDatabase(url!, "api_images"), { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    blobs = new MemoryBlobStore();
    const keyring = new TenantKeyring(db, new LocalKeyProvider({ v1: randomBytes(32) }));
    const now = () => clock;
    services = {
      db,
      config,
      now,
      auth: new AuthService(db, config, createLocalSecretBox(config.secretBoxKey), now),
      authRateLimiter: new RateLimiter(1000, 60_000, now),
      vault: { keyring, blobs },
    };
    tenantId = await withPlatform(db, async (tx) => (await tx.insert(schema.tenants).values({ name: "A社", status: "active" }).returning())[0]!.id);
    const blobKey = await putEncryptedBlob(blobs, keyring, tenantId, image);
    const cardNumberEnc = await encryptCardNumber(keyring, tenantId, "AB12345678CD");
    const cardNumberHmacValue = await cardNumberHmac(keyring, tenantId, "AB12345678CD");
    await withTenant(db, tenantId, async (tx) => {
      const [tokyo, osaka] = await tx.insert(schema.sites).values([{ name: "東京" }, { name: "大阪" }]).returning();
      const mk = async (email: string, role: "tenant_admin" | "site_admin" | "viewer", site?: string) => {
        const [u] = await tx.insert(schema.users).values({ email, role, status: "active" }).returning();
        if (site) await tx.insert(schema.userSites).values({ userId: u!.id, siteId: site });
        return u!.id;
      };
      users.admin = await mk("admin@example.com", "tenant_admin");
      users.tokyo = await mk("tokyo@example.com", "site_admin", tokyo!.id);
      users.osaka = await mk("osaka@example.com", "site_admin", osaka!.id);
      users.viewer = await mk("viewer@example.com", "viewer", tokyo!.id);
      const [p] = await tx.insert(schema.persons).values({ siteId: tokyo!.id, employeeCode: "E1", name: "テスト" }).returning();
      const [card] = await tx
        .insert(schema.residenceCards)
        .values({ personId: p!.id, cardFormat: "gen2", cardNumberEnc, cardNumberHmac: cardNumberHmacValue })
        .returning();
      const [img] = await tx.insert(schema.cardImages).values({ cardId: card!.id, kind: "front", blobKey, contentType: "image/jpeg" }).returning();
      imageId = img!.id;
    });
  });
  afterAll(async () => end?.());

  it("担当拠点の拠点管理者は URL を得て、復号された画像を取得できる", async () => {
    const { url: u, expiresIn } = await (await as("tokyo")).cards.getImageUrl({ imageId });
    expect(u.startsWith("https://api.example.com/files/images/")).toBe(true);
    expect(expiresIn).toBe(120);
    const r = await serveImage(services, tokenOf(u));
    expect(r.status).toBe(200);
    expect(r.body.equals(image)).toBe(true);
    expect(r.headers["Content-Type"]).toBe("image/jpeg");
    expect(r.headers["Cache-Control"]).toContain("no-store");
  });

  it("URL の発行を監査ログに記録する", async () => {
    await (await as("admin")).cards.getImageUrl({ imageId });
    const logs = await withTenant(db, tenantId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "card_image.view")),
    );
    expect(logs.some((l) => l.actorId === users.admin && l.targetId === imageId && l.ip === "10.0.0.1")).toBe(true);
  });

  it("担当外の拠点管理者には存在しないものとして扱う", async () => {
    const e = await (await as("osaka")).cards.getImageUrl({ imageId }).catch((x: unknown) => x);
    expect((e as TRPCError).code).toBe("NOT_FOUND");
  });

  it("閲覧者はカード画像を見られない", async () => {
    const e = await (await as("viewer")).cards.getImageUrl({ imageId }).catch((x: unknown) => x);
    expect((e as TRPCError).code).toBe("FORBIDDEN");
  });

  it("URL は 2 分で切れる", async () => {
    const { url: u } = await (await as("tokyo")).cards.getImageUrl({ imageId });
    clock += 121_000;
    expect((await serveImage(services, tokenOf(u))).status).toBe(404);
  });

  it("アクセストークンや改ざんしたトークンでは取得できない", async () => {
    const access = await signToken(config.jwtSecret, { userId: users.admin, tenantId, type: "access" }, 900, Math.floor(clock / 1000));
    expect((await serveImage(services, access)).status).toBe(404);
    const { url: u } = await (await as("tokyo")).cards.getImageUrl({ imageId });
    expect((await serveImage(services, tokenOf(u).slice(0, -2) + "xx")).status).toBe(404);
  });

  it("Blob 上は暗号文で、カード番号も DB に平文で残らない", async () => {
    for (const v of blobs.data.values()) expect(v.includes(image.subarray(0, 32))).toBe(false);
    const rows = await withTenant(db, tenantId, (tx) => tx.select().from(schema.residenceCards));
    expect(rows[0]!.cardNumberEnc.includes(Buffer.from("AB12345678CD"))).toBe(false);
  });
});
