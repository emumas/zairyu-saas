import { z } from "zod";
import { issueImageUrl } from "../images.js";
import { permissionProcedure, router } from "../trpc.js";

/** カード(1-7 で登録・IC 検証の手続きを追加する) */
export const cardsRouter = router({
  /** カード画像を見るための短命な URL。発行は監査ログに記録される */
  getImageUrl: permissionProcedure("cards.viewImage")
    .input(z.object({ imageId: z.uuid() }))
    .output(z.object({ url: z.string(), expiresIn: z.number() }))
    .mutation(({ ctx, input }) => ctx.tenantTx((tx) => issueImageUrl(ctx.services, tx, ctx.actor, input.imageId, ctx.ip))),
});
