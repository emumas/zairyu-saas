import { isValidCardNumber, normalizeCardNumberInput } from "@zairyu/shared";
import { z } from "zod";
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: publicProcedure.output(z.object({ status: z.literal("ok") })).query(() => ({ status: "ok" as const })),

  /** PoC 用: 手入力されたカード番号の形式チェック */
  validateCardNumber: publicProcedure
    .input(z.object({ cardNumber: z.string().max(64) }))
    .output(z.object({ normalized: z.string(), valid: z.boolean() }))
    .query(({ input }) => {
      const normalized = normalizeCardNumberInput(input.cardNumber);
      return { normalized, valid: isValidCardNumber(normalized) };
    }),
});

export type AppRouter = typeof appRouter;
