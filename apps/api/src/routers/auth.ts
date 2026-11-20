import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../auth/password.js";
import { publicProcedure, requireServices, router, type Context } from "../trpc.js";

function limit(ctx: Context) {
  if (!requireServices(ctx).authRateLimiter.take(ctx.ip ?? "unknown")) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "しばらく時間をおいてから再度お試しください" });
  }
}

/** Web では refreshToken を空文字で返し、HttpOnly Cookie に入れる */
const tokenPair = z.object({ accessToken: z.string(), accessTokenExpiresIn: z.number(), refreshToken: z.string() });

/** リフレッシュトークンの Cookie(JavaScript から読めない。認証系の手続きにだけ送られる) */
export const REFRESH_COOKIE = "zr_rt";
const REFRESH_COOKIE_PATH = "/trpc/auth";

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
