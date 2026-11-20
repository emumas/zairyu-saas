import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../auth/password.js";
import { authedProcedure, publicProcedure, requireServices, router, type Context } from "../trpc.js";

function limit(ctx: Context) {
  if (!requireServices(ctx).authRateLimiter.take(ctx.ip ?? "unknown")) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "しばらく時間をおいてから再度お試しください" });
  }
}

/** Web では refreshToken を空文字で返し、HttpOnly Cookie に入れる */
const tokenPair = z.object({ accessToken: z.string(), accessTokenExpiresIn: z.number(), refreshToken: z.string() });

/**
 * リフレッシュトークンの Cookie(HttpOnly で JavaScript から読めない)。
 * Path は /trpc。手続きの URL は /trpc/auth.refresh のように「.」で続くため、/trpc/auth にすると
 * Cookie のパス照合(直後が「/」であること)に合わず送られない
 */
export const REFRESH_COOKIE = "zr_rt";
const REFRESH_COOKIE_PATH = "/trpc";

function deliver<T extends { refreshToken: string }>(ctx: Context, pair: T): T {
  if (!ctx.web) return pair;
  ctx.web.setCookie(REFRESH_COOKIE, pair.refreshToken, {
    maxAgeSec: requireServices(ctx).config.refreshTokenTtlSec,
    path: REFRESH_COOKIE_PATH,
  });
  return { ...pair, refreshToken: "" };
}

function refreshTokenFrom(ctx: Context, input: string | undefined): string | null {
  return input || ctx.web?.cookies[REFRESH_COOKIE] || null;
}
const totpCode = z.string().regex(/^\d{6}$/, "6 桁の数字を入力してください");
const meta = (ctx: Context, deviceName?: string) => ({ ip: ctx.ip, deviceName });

export const authRouter = router({
  login: publicProcedure
    .input(
      z.object({
        email: z.string().trim().max(254),
        password: z.string().max(PASSWORD_MAX_LENGTH),
        deviceName: z.string().max(100).optional(),
      }),
    )
    .output(
      z.discriminatedUnion("status", [
        tokenPair.extend({ status: z.literal("ok") }),
        z.object({ status: z.literal("totp_required"), challengeToken: z.string() }),
        z.object({ status: z.literal("totp_setup_required"), setupToken: z.string() }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      const r = await requireServices(ctx).auth.login(input.email, input.password, meta(ctx, input.deviceName));
      return r.status === "ok" ? deliver(ctx, r) : r;
    }),

  verifyTotp: publicProcedure
    .input(z.object({ challengeToken: z.string().max(2000), code: totpCode, deviceName: z.string().max(100).optional() }))
    .output(tokenPair)
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      return deliver(ctx, await requireServices(ctx).auth.verifyTotp(input.challengeToken, input.code, meta(ctx, input.deviceName)));
    }),

  beginTotpSetup: publicProcedure
    .input(z.object({ setupToken: z.string().max(2000) }))
    .output(z.object({ secret: z.string(), otpauthUri: z.string() }))
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.beginTotpSetup(input.setupToken);
    }),

  confirmTotpSetup: publicProcedure
    .input(z.object({ setupToken: z.string().max(2000), code: totpCode, deviceName: z.string().max(100).optional() }))
    .output(tokenPair)
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      return deliver(ctx, await requireServices(ctx).auth.confirmTotpSetup(input.setupToken, input.code, meta(ctx, input.deviceName)));
    }),

  /** 招待を受けてパスワードを設定する */
  acceptInvitation: publicProcedure
    .input(z.object({ token: z.string().max(200), password: z.string().max(PASSWORD_MAX_LENGTH) }))
    .output(z.object({ email: z.string() }))
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.acceptInvitation(input.token, input.password, meta(ctx));
    }),

  /**
   * パスワードを忘れた場合: 再設定のリンクをメールで送る。
   * 登録の有無が分からないよう、いつも同じ応答を返す
   */
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().trim().max(254) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      await requireServices(ctx).auth.requestPasswordReset(input.email, meta(ctx));
      return { ok: true as const };
    }),

  /** 再設定のリンクから新しいパスワードを設定する */
  resetPassword: publicProcedure
    .input(z.object({ token: z.string().max(200), password: z.string().max(PASSWORD_MAX_LENGTH) }))
    .output(z.object({ email: z.string() }))
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.resetPassword(input.token, input.password, meta(ctx));
    }),

  /** ログイン中のパスワード変更。ほかの端末はログアウトされ、この端末には新しいトークンを返す */
  changePassword: authedProcedure
    .input(z.object({ currentPassword: z.string().max(PASSWORD_MAX_LENGTH), newPassword: z.string().max(PASSWORD_MAX_LENGTH) }))
    .output(tokenPair)
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      const pair = await ctx.services.auth.changePassword(ctx.actor.userId, ctx.actor.tenantId, input.currentPassword, input.newPassword, meta(ctx));
      return deliver(ctx, pair);
    }),

  /** 認証アプリの付け替え(今の認証アプリが手元にある場合)の 1 段目 */
  beginTotpChange: authedProcedure
    .input(z.object({ password: z.string().max(PASSWORD_MAX_LENGTH), code: z.string().max(10) }))
    .output(z.object({ secret: z.string(), otpauthUri: z.string(), changeToken: z.string() }))
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return ctx.services.auth.beginTotpChange(ctx.actor.userId, ctx.actor.tenantId, input.password, input.code, meta(ctx));
    }),

  /** 付け替えの 2 段目(新しい認証アプリの 6 桁) */
  confirmTotpChange: authedProcedure
    .input(z.object({ changeToken: z.string().max(4000), code: z.string().regex(/^\d{6}$/, "6 桁の数字を入力してください") }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      await ctx.services.auth.confirmTotpChange(ctx.actor.userId, ctx.actor.tenantId, input.changeToken, input.code, meta(ctx));
      return { ok: true as const };
    }),

  /** Web は refreshToken を省略し、Cookie のものを使う */
  refresh: publicProcedure
    .input(z.object({ refreshToken: z.string().max(200).optional() }))
    .output(tokenPair)
    .mutation(async ({ ctx, input }) => {
      limit(ctx);
      const token = refreshTokenFrom(ctx, input.refreshToken);
      if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "ログインが必要です" });
      return deliver(ctx, await requireServices(ctx).auth.refresh(token, meta(ctx)));
    }),

  logout: publicProcedure
    .input(z.object({ refreshToken: z.string().max(200).optional() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const token = refreshTokenFrom(ctx, input.refreshToken);
      if (token) await requireServices(ctx).auth.logout(token, meta(ctx));
      ctx.web?.setCookie(REFRESH_COOKIE, "", { maxAgeSec: 0, path: REFRESH_COOKIE_PATH });
      return { ok: true as const };
    }),
});
