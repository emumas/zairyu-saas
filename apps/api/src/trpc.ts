import { initTRPC } from "@trpc/server";

/**
 * リクエストコンテキスト。
 * TODO(1-2/1-3): セッションから tenantId・ロール・担当拠点を解決して入れる。
 * tenantId はクライアント入力から受け取らない(CLAUDE.md ルール1)。
 */
export interface Context {
  requestId: string;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
