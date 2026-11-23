/**
 * 住所から郵便番号を引く(日本郵便のデータを DB に入れて照合する。住所を外部に送らない)。
 * 画面で候補を出すために使う。照合した住所は記録しない
 */
import { correctAddressNames, lookupPostalCode } from "@zairyu/db";
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

  /**
   * 端末で読み取った住所の地名の読み違い(岐卓県・新栄ニ丁目 など)を郵便番号データの表記に直し、郵便番号も引く。
   * 画面で入力欄に入れる前に使う(直した住所は画面で確認してから保存する)。住所は記録しない
   */
  correct: permissionProcedure("cards.write")
    .input(z.object({ address: addressInput }))
    .output(z.object({ address: z.string(), changed: z.boolean(), postalCode: z.string().nullable() }))
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const r = await correctAddressNames(tx, input.address);
        return { ...r, postalCode: (await lookupPostalCode(tx, r.address)).postalCode };
      }),
    ),
});
