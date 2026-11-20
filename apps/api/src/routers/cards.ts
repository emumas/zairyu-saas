/**
 * カード(1-7)。登録の流れ(DESIGN.md 4章):
 *   端末: 表面撮影 → 番号(OCR)→ IC 読取 → cards.verifyIcRead(照合結果の表示)→ 裏面撮影 → cards.register
 * - サーバーは register のときにも IC を検証し直す(端末の結果は使わない)
 * - 署名検証に失敗したカードは「要確認(偽造の疑い)」として保存する
 * - 券面と IC が食い違う場合は理由(diffReason)が無いと保存できない
 * - IC が読めない場合は「IC 未検証」として保存する
 */
import {
  alertRecipients,
  enqueueNotifications,
  findOtherPersonWithCard,
  insertAlertsIfAbsent,
  findPersonSite,
  insertCardImage,
  insertVerification,
  listCardsForPerson,
  replaceCurrentCard,
  type Tx,
} from "@zairyu/db";
import { cardRegisterInput, cardVerifyInput, jstDate, needsReviewNotice } from "@zairyu/shared";
import { cardNumberHmac, encryptCardNumber, putEncryptedBlob } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import type { Actor } from "../authz/permissions.js";
import { diffFields, evaluateIc, judgeSignature, mergeFields } from "../cards/evaluate.js";
import { toDisplayImage } from "../imageConvert.js";
import { getDisplayImage, issueImageUrl } from "../images.js";
import { permissionProcedure, requireVault, router } from "../trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

async function loadActivePerson(tx: Tx, actor: Actor, personId: string) {
  const p = await findPersonSite(tx, personId);
  if (!p) throw notFound();
  assertSiteAccess(actor, p.siteId);
  if (p.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "在籍中の登録者にだけカードを登録できます" });
  return p;
}

const signatureOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("valid"),
    issuerTrusted: z.boolean().nullable(),
    certificateValidAt: z.boolean(),
    matched: z.string(),
    hashFormat: z.enum(["raw", "digestInfo"]).optional(),
  }),
  z.object({ status: z.literal("invalid"), reason: z.string(), detail: z.string().optional() }),
  z.object({ status: z.literal("absent") }),
]);

const fieldsOutput = z.object({
  statusOfResidence: z.string().nullable(),
  periodOfStay: z.string().nullable(),
  permissionType: z.string().nullable(),
  permittedAt: z.string().nullable(),
  expiryDate: z.string().nullable(),
  cardValidUntil: z.string().nullable(),
  workRestriction: z.string().nullable(),
  outsideActivity: z.string().nullable(),
  outsideActivityUntil: z.string().nullable(),
  pendingApplication: z.boolean().nullable(),
});

const diffOutput = z.object({
  field: z.enum(["cardNumber", "expiryDate", "cardValidUntil", "statusOfResidence", "workRestriction", "pendingApplication"]),
  ic: z.union([z.string(), z.boolean()]).nullable(),
  input: z.union([z.string(), z.boolean()]).nullable(),
});

export const cardsRouter = router({
  /** 登録前の確認: 署名検証と券面との照合(保存しない) */
  verifyIcRead: permissionProcedure("cards.write")
    .input(cardVerifyInput)
    .output(
      z.object({
        format: z.enum(["legacy", "gen2", "tokutei"]),
        kind: z.enum(["residence", "special_permanent"]),
        signature: signatureOutput,
        icVerified: z.boolean(),
        needsReview: z.boolean(),
        /** 保存される値(IC 優先、無い項目は入力) */
        fields: fieldsOutput,
        diffs: z.array(diffOutput),
        /** IC 内の画像(表示用に変換済み)。撮影した券面と見比べる */
        icImages: z.array(z.object({ kind: z.string(), contentType: z.string(), data: z.string(), width: z.number(), height: z.number() })),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await loadActivePerson(tx, ctx.actor, input.personId);
        const ic = evaluateIc(input.ic);
        // 住居地イメージは照合に使わないので返さない(通信量を抑える)
        const icImages = await Promise.all(
          ic.images
            .filter((img) => img.kind !== "ic_address")
            .map(async (img) => {
              try {
                const d = await toDisplayImage(img.contentType, img.data);
                return [{ kind: img.kind, contentType: d.contentType, data: d.data.toString("base64"), width: d.width, height: d.height }];
              } catch {
                return [];
              }
            }),
        );
        const judged = judgeSignature(ic.signature);
        await ctx.audit(tx, {
          action: "card.ic_verify",
          targetType: "person",
          targetId: input.personId,
          detail: { format: ic.format, signature: ic.signature.status },
        });
        return {
          format: ic.format,
          kind: ic.kind,
          signature: ic.signature,
          icVerified: judged.icVerified,
          needsReview: judged.needsReview,
          fields: mergeFields(ic, input.manual),
          diffs: diffFields(ic, input.cardNumber, input.manual),
          icImages: icImages.flat(),
        };
      }),
    ),

  /** カードを登録する(以前のカードは履歴として残る) */
  register: permissionProcedure("cards.write")
    .input(cardRegisterInput)
    .output(
      z.object({
        cardId: z.string(),
        icVerified: z.boolean(),
        needsReview: z.boolean(),
        diffs: z.array(diffOutput),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const vault = requireVault(ctx.services);
      const tenantId = ctx.actor.tenantId;
      // 重い処理(署名検証・暗号化・Blob 保存)はトランザクションの外で先に行う
      const ic = input.ic ? evaluateIc(input.ic) : null;
      const diffs = diffFields(ic, input.cardNumber, input.manual);
      if (diffs.length > 0 && !input.diffReason) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "券面と IC の内容が一致しません。差分を確認し、理由を入力してください" });
      }
      if (!ic && !input.icFailureReason) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "IC を読み取れなかった理由を選んでください" });
      }
      const fields = mergeFields(ic, input.manual);
      // 永住者には在留期間の満了日がない(券面の日付はカードの有効期限)。取り違えると期限切れを誤警告するため止める
      if (/永住者/.test(fields.statusOfResidence ?? "") && input.manual.expiryDate && !ic?.fields.expiryDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "永住者には在留期間の満了日がありません。券面の日付は「カードの有効期限」として入力してください" });
      }
      const judged = ic ? judgeSignature(ic.signature) : { icVerified: false, needsReview: false, result: null };
      const [numberEnc, numberHmac] = await Promise.all([
        encryptCardNumber(vault.keyring, tenantId, input.cardNumber),
        cardNumberHmac(vault.keyring, tenantId, input.cardNumber),
      ]);
      const images = [
        ...(ic?.images ?? []),
        ...(input.photos.front ? [{ kind: "front" as const, contentType: input.photos.front.contentType, data: Buffer.from(input.photos.front.data, "base64") }] : []),
        ...(input.photos.back ? [{ kind: "back" as const, contentType: input.photos.back.contentType, data: Buffer.from(input.photos.back.data, "base64") }] : []),
      ];
      const stored = await Promise.all(
        images.map(async (img) => ({ ...img, blobKey: await putEncryptedBlob(vault.blobs, vault.keyring, tenantId, img.data) })),
      );
      // TODO(1-21): 登録に失敗した場合に残った Blob を掃除するジョブ

      return ctx.tenantTx(async (tx) => {
        const person = await loadActivePerson(tx, ctx.actor, input.personId);
        if (await findOtherPersonWithCard(tx, numberHmac, input.personId)) {
          throw new TRPCError({ code: "CONFLICT", message: "同じ在留カード番号が別の登録者に登録されています" });
        }
        const today = jstDate(ctx.services.now());
        const cardId = await replaceCurrentCard(tx, input.personId, {
          cardFormat: ic?.format ?? "legacy",
          cardKind: ic?.kind ?? "residence",
          cardNumberEnc: numberEnc,
          cardNumberHmac: numberHmac,
          ...fields,
          pendingApplication: fields.pendingApplication ?? false,
          pendingApplicationSince: fields.pendingApplication ? today : null,
          icVerified: judged.icVerified,
          needsReview: judged.needsReview,
        });
        for (const img of stored) {
          await insertCardImage(tx, { cardId, kind: img.kind, blobKey: img.blobKey, contentType: img.contentType });
        }
        if (ic) {
          await insertVerification(tx, {
            cardId,
            method: "ic_signature",
            result: judged.result!,
            diffJson: { signature: ic.signature },
            performedBy: ctx.actor.userId,
            deviceId: input.deviceId ?? null,
          });
        }
        // 管理者による券面の確認(目視)。差分や IC が読めなかった理由もここに残す
        await insertVerification(tx, {
          cardId,
          method: "visual",
          result: diffs.length > 0 ? "mismatch" : "ok",
          diffJson: diffs.length > 0 ? { diffs } : null,
          note: input.diffReason ?? (ic ? null : `IC 読取不可: ${input.icFailureReason}`),
          performedBy: ctx.actor.userId,
          deviceId: input.deviceId ?? null,
        });
        await ctx.audit(tx, {
          action: "card.register",
          targetType: "residence_card",
          targetId: cardId,
          detail: { personId: input.personId, format: ic?.format ?? null, icVerified: judged.icVerified, needsReview: judged.needsReview, images: stored.map((i) => i.kind) },
        });
        // 署名検証に失敗(偽造の疑い)したら、アラートを作って管理者へ即時通知する(送信はワーカーが数分以内に行う)
        if (judged.needsReview) {
          await insertAlertsIfAbsent(tx, [{ personId: input.personId, cardId, type: "needs_review", dueDate: today }]);
          const recipients = (await alertRecipients(tx, person.siteId)).map((r) => r.id);
          await enqueueNotifications(tx, recipients, needsReviewNotice(), new Date(ctx.services.now()));
        }
        return { cardId, icVerified: judged.icVerified, needsReview: judged.needsReview, diffs };
      });
    }),

  /** 登録者のカード履歴と確認履歴 */
  listForPerson: permissionProcedure("verifications.read")
    .input(z.object({ personId: z.uuid() }))
    .output(
      z.array(
        fieldsOutput.extend({
          id: z.string(),
          cardFormat: z.enum(["legacy", "gen2", "tokutei"]),
          cardKind: z.enum(["residence", "special_permanent"]),
          pendingApplication: z.boolean(),
          icVerified: z.boolean(),
          needsReview: z.boolean(),
          isCurrent: z.boolean(),
          createdAt: z.date(),
          images: z.array(z.object({ id: z.string(), kind: z.string() })),
          verifications: z.array(
            z.object({
              id: z.string(),
              method: z.string(),
              result: z.string(),
              note: z.string().nullable(),
              performedBy: z.string(),
              performedAt: z.date(),
            }),
          ),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const p = await findPersonSite(tx, input.personId);
        if (!p) throw notFound();
        assertSiteAccess(ctx.actor, p.siteId);
        const cards = await listCardsForPerson(tx, input.personId);
        return cards.map((c) => ({ ...c, permissionType: null, permittedAt: null }));
      }),
    ),

  /** カード画像を表示用に変換してデータで返す(アプリ向け)。閲覧は監査ログに記録される */
  getImage: permissionProcedure("cards.viewImage")
    .input(z.object({ imageId: z.uuid() }))
    .output(z.object({ kind: z.string(), contentType: z.enum(["image/png", "image/jpeg"]), data: z.string(), width: z.number(), height: z.number() }))
    .mutation(({ ctx, input }) => ctx.tenantTx((tx) => getDisplayImage(ctx.services, tx, ctx.actor, input.imageId, ctx.audit))),

  /** カード画像を見るための短命な URL(Web 向け)。発行は監査ログに記録される */
  getImageUrl: permissionProcedure("cards.viewImage")
    .input(z.object({ imageId: z.uuid() }))
    .output(z.object({ url: z.string(), expiresIn: z.number() }))
    .mutation(({ ctx, input }) => ctx.tenantTx((tx) => issueImageUrl(ctx.services, tx, ctx.actor, input.imageId, ctx.audit))),
});
