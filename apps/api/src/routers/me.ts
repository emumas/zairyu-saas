import { schema } from "@zairyu/db";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { MATRIX, ROLES, siteScope } from "../authz/permissions.js";
import { tenantRestriction } from "../billingGuard.js";
import { authedProcedure, router } from "../trpc.js";

export const meRouter = router({
  /** ログイン中のユーザー・ロール・権限・見られる拠点(画面の出し分けに使う) */
  get: authedProcedure
    .output(
      z.object({
        userId: z.string(),
        email: z.string(),
        role: z.enum(ROLES),
        permissions: z.array(z.string()),
        sites: z.array(z.object({ id: z.string(), name: z.string() })),
        /** 未払い時の制御(1-18)。画面のお知らせと「登録者を追加」の出し分けに使う */
        billing: z.discriminatedUnion("state", [
          z.object({ state: z.literal("ok") }),
          z.object({ state: z.literal("grace"), graceEndsAt: z.string().nullable() }),
          z.object({ state: z.literal("restricted"), since: z.string() }),
        ]),
      }),
    )
    .query(async ({ ctx }) => {
      const { actor } = ctx;
      return ctx.tenantTx(async (tx) => {
        const [user] = await tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, actor.userId));
        const scope = siteScope(actor);
        const sites =
          scope === null
            ? await tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites)
            : scope.length === 0
              ? []
              : await tx.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).where(inArray(schema.sites.id, [...scope]));
        const billing = await tenantRestriction(tx, ctx.services.now());
        return { userId: actor.userId, email: user!.email, role: actor.role, permissions: [...MATRIX[actor.role]], sites, billing };
      });
    }),
});
