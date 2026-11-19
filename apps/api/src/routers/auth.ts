import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../auth/password.js";
import { publicProcedure, requireServices, router, type Context } from "../trpc.js";

function limit(ctx: Context) {
  if (!requireServices(ctx).authRateLimiter.take(ctx.ip ?? "unknown")) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "しばらく時間をおいてから再度お試しください" });
  }
}

const tokenPair = z.object({ accessToken: z.string(), accessTokenExpiresIn: z.number(), refreshToken: z.string() });
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
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.login(input.email, input.password, meta(ctx, input.deviceName));
    }),

  verifyTotp: publicProcedure
    .input(z.object({ challengeToken: z.string().max(2000), code: totpCode, deviceName: z.string().max(100).optional() }))
    .output(tokenPair)
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.verifyTotp(input.challengeToken, input.code, meta(ctx, input.deviceName));
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
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.confirmTotpSetup(input.setupToken, input.code, meta(ctx, input.deviceName));
    }),

  refresh: publicProcedure
    .input(z.object({ refreshToken: z.string().max(200) }))
    .output(tokenPair)
    .mutation(({ ctx, input }) => {
      limit(ctx);
      return requireServices(ctx).auth.refresh(input.refreshToken, meta(ctx));
    }),

  logout: publicProcedure
    .input(z.object({ refreshToken: z.string().max(200) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await requireServices(ctx).auth.logout(input.refreshToken, meta(ctx));
      return { ok: true as const };
    }),
});
