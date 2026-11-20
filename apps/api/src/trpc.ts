import { insertAudit, withTenant, schema, type AuditEntry, type Db, type Tx } from "@zairyu/db";
import type { Vault } from "@zairyu/vault";
import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { AuthService } from "./auth/service.js";
import { verifyToken } from "./auth/tokens.js";
import { can, type Actor, type Permission } from "./authz/permissions.js";
import type { Config } from "./config.js";
import type { RateLimiter } from "./rateLimit.js";

export interface Services {
  db: Db;
  config: Config;
  auth: AuthService;
  now: () => number;
  /** 認証系の手続きの IP 単位レート制限 */
  authRateLimiter: RateLimiter;
  /** テナント別の鍵とファイル保存先(未設定ならカード番号・画像を扱う API は使えない) */
  vault: Vault | null;
}

/**
 * リクエストコンテキスト。
 * テナント ID はアクセストークン(サーバーが署名)からだけ得る。クライアント入力からは受け取らない(CLAUDE.md ルール1)
 */
export interface Context {
  requestId: string;
  /** DB 等。未設定(DATABASE_URL なし)なら認証が必要な手続きは使えない */
  services: Services | null;
  /** Authorization: Bearer のトークン */
  accessToken: string | null;
  ip: string | null;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

export function requireVault(services: Services): Vault {
  if (!services.vault) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "暗号化の設定が不足しています" });
  return services.vault;
}

export function requireServices(ctx: Context): Services {
  if (!ctx.services) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "サーバーの設定が不足しています" });
  return ctx.services;
}

const unauthorized = () => new TRPCError({ code: "UNAUTHORIZED", message: "ログインが必要です" });

/**
 * 認証: アクセストークンを検証し、ユーザー・ロール・担当拠点を DB から引き直す
 * (ロール変更や停止をトークンの有効期限を待たずに反映するため)
 */
const authed = t.middleware(async ({ ctx, next, type, path }) => {
  const services = requireServices(ctx);
  if (!ctx.accessToken) throw unauthorized();
  const claims = await verifyToken(services.config.jwtSecret, ctx.accessToken, "access", Math.floor(services.now() / 1000));
  if (!claims) throw unauthorized();

  const loaded = await withTenant(services.db, claims.tenantId, async (tx) => {
    const [user] = await tx
      .select({ role: schema.users.role, status: schema.users.status, tenantStatus: schema.tenants.status })
      .from(schema.users)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
      .where(eq(schema.users.id, claims.userId));
    if (!user) return null;
    const sites = await tx
      .select({ siteId: schema.userSites.siteId })
      .from(schema.userSites)
      .where(and(eq(schema.userSites.userId, claims.userId)));
    return { ...user, siteIds: sites.map((s) => s.siteId) };
  });
  if (!loaded || loaded.status !== "active") throw unauthorized();
  if (loaded.tenantStatus === "suspended") {
    throw new TRPCError({ code: "FORBIDDEN", message: "ご契約が停止されています。管理者にお問い合わせください" });
  }

  const actor: Actor = { userId: claims.userId, tenantId: claims.tenantId, role: loaded.role, siteIds: loaded.siteIds };
  let auditCount = 0;
  return next({
    ctx: {
      ...ctx,
      services,
      actor,
      /**
       * 監査ログを書く(1-5)。変更系の手続きは tenantTx の中で必ず 1 件以上書くこと。
       * detail には変更した項目名などだけを入れ、値(個人情報)は入れない
       */
      audit: async (tx: Tx, entry: Omit<AuditEntry, "actorId" | "ip">) => {
        await insertAudit(tx, { ...entry, actorId: actor.userId, ip: ctx.ip });
        auditCount++;
      },
      /**
       * このユーザーのテナントに固定したトランザクション。
       * mutation で監査ログを書かずに終わろうとしたら、エラーにして変更ごとロールバックする
       */
      tenantTx: <T>(fn: (tx: Tx) => Promise<T>) =>
        withTenant(services.db, actor.tenantId, async (tx) => {
          const before = auditCount;
          const result = await fn(tx);
          if (type === "mutation" && auditCount === before) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `監査ログが記録されていません(${path})` });
          }
          return result;
        }),
    },
  });
});

/** ログインしていれば使える手続き */
export const authedProcedure = t.procedure.use(authed);

/** 権限を宣言した手続き。すべての業務 API はこれを使う */
export function permissionProcedure(permission: Permission) {
  return authedProcedure.use(({ ctx, next }) => {
    if (!can(ctx.actor.role, permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "この操作を行う権限がありません" });
    }
    return next();
  });
}
