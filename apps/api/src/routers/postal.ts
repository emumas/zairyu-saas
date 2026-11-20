/**
 * 住所から郵便番号を引く(日本郵便のデータを DB に入れて照合する。住所を外部に送らない)。
 * 画面で候補を出すために使う。照合した住所は記録しない
 */
import { lookupPostalCode } from "@zairyu/db";
import { addressInput } from "@zairyu/shared";
import { z } from "zod";
import { permissionProcedure, router } from "../trpc.js";

export const postalRouter = router({
  lookup: permissionProcedure("cards.write")
    .input(z.object({ address: addressInput }))
    .output(
      z.object({
        postalCode: z.string().nullable(),
        level: z.enum(["town", "city"]).nullable(),
        candidates: z.array(z.object({ code: z.string(), label: z.string() })),
        /** 郵便番号データが未投入なら false */
        loaded: z.boolean(),
      }),
    )
    .query(({ ctx, input }) => ctx.tenantTx((tx) => lookupPostalCode(tx, input.address))),
});
