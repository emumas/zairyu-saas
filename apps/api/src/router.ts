import { TRPCError } from "@trpc/server";
import { isValidCardNumber, normalizeCardNumberInput } from "@zairyu/shared";
import { z } from "zod";
import { verifyIcRead, verifyIcReadInput, verifyIcReadOutput } from "./poc.js";
import { alertsRouter } from "./routers/alerts.js";
import { authRouter } from "./routers/auth.js";
import { devicesRouter } from "./routers/devices.js";
import { cardsRouter } from "./routers/cards.js";
import { dashboardRouter } from "./routers/dashboard.js";
import { meRouter } from "./routers/me.js";
import { importsRouter } from "./routers/imports.js";
import { orgRouter } from "./routers/org.js";
import { reportsRouter } from "./routers/reports.js";
import { personsRouter } from "./routers/persons.js";
import { verificationsRouter } from "./routers/verifications.js";
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  auth: authRouter,
  me: meRouter,
  cards: cardsRouter,
  persons: personsRouter,
  dashboard: dashboardRouter,
  alerts: alertsRouter,
  devices: devicesRouter,
  verifications: verificationsRouter,
  org: orgRouter,
  imports: importsRouter,
  reports: reportsRouter,

  health: publicProcedure.output(z.object({ status: z.literal("ok") })).query(() => ({ status: "ok" as const })),

  /** PoC 用: 手入力されたカード番号の形式チェック */
  validateCardNumber: publicProcedure
    .input(z.object({ cardNumber: z.string().max(64) }))
    .output(z.object({ normalized: z.string(), valid: z.boolean() }))
    .query(({ input }) => {
      const normalized = normalizeCardNumberInput(input.cardNumber);
      return { normalized, valid: isValidCardNumber(normalized) };
    }),

  poc: router({
    /**
     * PoC 用。認証なしのため開発環境でのみ有効にする(ZAIRYU_ENABLE_POC=1)
     */
    verifyIcRead: publicProcedure
      .input(verifyIcReadInput)
      .output(verifyIcReadOutput)
      .mutation(({ input }) => {
        if (process.env.ZAIRYU_ENABLE_POC !== "1") throw new TRPCError({ code: "NOT_FOUND" });
        return verifyIcRead(input);
      }),
  }),
});

export type AppRouter = typeof appRouter;
