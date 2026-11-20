/**
 * 確認の記録(1-9 失効情報照会)。
 * 照会は管理者が入管庁のページで行い、ここでは番号の表示と結果の記録だけを行う(機械的な照会はしない)
 */
import {
  alertRecipients,
  enqueueNotifications,
  getCardWithSite,
  insertAlertsIfAbsent,
  insertVerification,
  markCardNeedsReview,
  type Tx,
} from "@zairyu/db";
import { addDays, jstDate, recheckRevocationNotice, recordRevocationCheckInput, revokedNotice } from "@zairyu/shared";
import { decryptCardNumber } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import type { Actor } from "../authz/permissions.js";
import { permissionProcedure, requireVault, router } from "../trpc.js";

async function loadCurrentCard(tx: Tx, actor: Actor, cardId: string) {
  const card = await getCardWithSite(tx, cardId);
  if (!card) throw new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });
  assertSiteAccess(actor, card.siteId);
  if (!card.isCurrent) throw new TRPCError({ code: "BAD_REQUEST", message: "現在のカードだけ照会できます" });
  return card;
}

/** JST の日付の 9:00(通知を送る時刻) */
const jstNineAm = (date: string) => new Date(`${date}T09:00:00+09:00`);

export const verificationsRouter = router({
  /** 照会に入力する番号と有効期間の満了日。番号を表示したことを監査ログに残す */
  revocationCheckInfo: permissionProcedure("verifications.write")
    .input(z.object({ cardId: z.uuid() }))
    .output(
      z.object({
        cardNumber: z.string(),
        validUntil: z.string().nullable(),
        /** card: カードの有効期限 / stay: 在留期間の満了日で代用(旧様式で有効期限が未入力) */
        validUntilBasis: z.enum(["card", "stay"]).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCard(tx, ctx.actor, input.cardId);
        const vault = requireVault(ctx.services);
        const cardNumber = await decryptCardNumber(vault.keyring, ctx.actor.tenantId, card.cardNumberEnc);
        await ctx.audit(tx, { action: "card.reveal_number", targetType: "residence_card", targetId: card.id, detail: { purpose: "revocation_check" } });
        const validUntil = card.cardValidUntil ?? card.expiryDate;
        return { cardNumber, validUntil, validUntilBasis: card.cardValidUntil ? "card" : card.expiryDate ? "stay" : null };
      }),
    ),

  /** 照会の結果を記録する */
  recordRevocationCheck: permissionProcedure("verifications.write")
    .input(recordRevocationCheckInput)
    .output(z.object({ verificationId: z.string(), recheckOn: z.string().nullable() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCard(tx, ctx.actor, input.cardId);
        const today = jstDate(ctx.services.now());
        const result = input.result === "valid" ? "ok" : input.result === "revoked" ? "revoked" : "unverifiable";
        const verificationId = await insertVerification(tx, {
          cardId: card.id,
          method: "revocation_check",
          result,
          note: input.note ?? (input.result === "not_found" ? "照会結果が出ない(交付当日の可能性)" : null),
          performedBy: ctx.actor.userId,
          deviceId: input.deviceId ?? null,
        });
        let recheckOn: string | null = null;
        const recipients = async () => (await alertRecipients(tx, card.siteId)).map((r) => r.id);
        if (input.result === "revoked") {
          // 失効: 要確認にして、管理者へすぐ通知する
          await markCardNeedsReview(tx, card.id);
          await insertAlertsIfAbsent(tx, [{ personId: card.personId, cardId: card.id, type: "needs_review", dueDate: today }]);
          await enqueueNotifications(tx, await recipients(), revokedNotice(), new Date(ctx.services.now()));
        } else if (input.result === "not_found") {
          // 交付当日の分は翌日以降に反映されるため、翌朝に再照会を促す
          recheckOn = addDays(today, 1);
          await insertAlertsIfAbsent(tx, [{ personId: card.personId, cardId: card.id, type: "recheck_revocation", dueDate: recheckOn }]);
          await enqueueNotifications(tx, await recipients(), recheckRevocationNotice(), jstNineAm(recheckOn));
        }
        await ctx.audit(tx, {
          action: "card.revocation_check",
          targetType: "residence_card",
          targetId: card.id,
          detail: { result: input.result },
        });
        return { verificationId, recheckOn };
      }),
    ),
});
