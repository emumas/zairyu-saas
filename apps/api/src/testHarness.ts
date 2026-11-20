/** 結合テスト用の共通部品(本番コードからは使わない) */
import { randomBytes } from "node:crypto";
import { createDb, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { LocalKeyProvider, MemoryBlobStore, TenantKeyring } from "@zairyu/vault";
import { createLocalSecretBox } from "./auth/secretBox.js";
import { AuthService } from "./auth/service.js";
import { signToken } from "./auth/tokens.js";
import type { Role } from "./authz/permissions.js";
import type { Config } from "./config.js";
import { RateLimiter } from "./rateLimit.js";
import { appRouter } from "./router.js";
import { createCallerFactory, type Services } from "./trpc.js";

export const testConfig = (): Config => ({
  databaseUrl: undefined,
  jwtSecret: randomBytes(32),
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
});

const appCallerFactory = createCallerFactory(appRouter);
export type AppCaller = ReturnType<typeof appCallerFactory>;

export interface Harness {
  db: Db;
  services: Services;
  clock: { now: number };
  end: () => Promise<void>;
  createTenant(name: string): Promise<string>;
  createSite(tenantId: string, name: string): Promise<string>;
  createUser(tenantId: string, email: string, role: Role, siteIds?: string[]): Promise<string>;
  /** ログイン手順を省いてアクセストークンを作り、呼び出し口を返す(ログイン自体は auth.integration.test.ts で検証) */
  callerAs(tenantId: string, userId: string, ip?: string): Promise<AppCaller>;
  /** アクセストークンだけを作る */
  accessToken(tenantId: string, userId: string): Promise<string>;
}

export async function createHarness(dbSuffix: string): Promise<Harness> {
  const url = process.env.TEST_DATABASE_URL!;
  const c = createDb(await prepareTestDatabase(url, dbSuffix), { max: 4 });
  const db = c.db;
  const clock = { now: 2_000_000_000_000 };
  const now = () => clock.now;
  const config = testConfig();
  const services: Services = {
    db,
    config,
    now,
    auth: new AuthService(db, config, createLocalSecretBox(config.secretBoxKey), now),
    authRateLimiter: new RateLimiter(10_000, 60_000, now),
    vault: { keyring: new TenantKeyring(db, new LocalKeyProvider({ v1: randomBytes(32) })), blobs: new MemoryBlobStore() },
  };
  return {
    db,
    services,
    clock,
    end: () => c.pool.end(),
    createTenant: (name) =>
      withPlatform(db, async (tx) => (await tx.insert(schema.tenants).values({ name, status: "active" }).returning())[0]!.id),
    createSite: (tenantId, name) =>
      withTenant(db, tenantId, async (tx) => (await tx.insert(schema.sites).values({ name }).returning())[0]!.id),
    createUser: (tenantId, email, role, siteIds = []) =>
      withTenant(db, tenantId, async (tx) => {
        const [u] = await tx.insert(schema.users).values({ email, role, status: "active" }).returning();
        for (const siteId of siteIds) await tx.insert(schema.userSites).values({ userId: u!.id, siteId });
        return u!.id;
      }),
    accessToken: (tenantId, userId) =>
      signToken(config.jwtSecret, { userId, tenantId, type: "access" }, 900, Math.floor(clock.now / 1000)),
    callerAs: async (tenantId, userId, ip = "10.0.0.1") => {
      const token = await signToken(config.jwtSecret, { userId, tenantId, type: "access" }, 900, Math.floor(clock.now / 1000));
      return appCallerFactory({ requestId: "t", services, accessToken: token, ip });
    },
  };
}
