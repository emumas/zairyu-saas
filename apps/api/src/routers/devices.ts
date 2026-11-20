/** 端末のプッシュ通知トークンの登録(Expo Push) */
import { upsertPushToken } from "@zairyu/db";
import { z } from "zod";
import { authedProcedure, router } from "../trpc.js";

export const devicesRouter = router({
  registerPushToken: authedProcedure
    .input(z.object({ token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$/), platform: z.enum(["ios", "android"]) }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await upsertPushToken(tx, ctx.actor.userId, input.platform, input.token);
        await ctx.audit(tx, { action: "device.register_push", targetType: "user", targetId: ctx.actor.userId });
        return { ok: true as const };
      }),
    ),
});
