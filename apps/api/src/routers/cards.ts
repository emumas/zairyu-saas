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
  findPersonsWithCard,
  listEmployments,
  getCardState,
  fillPersonFromCard,
  getCardWithSite,
  updateCard,
  type CardPatch,
  insertAlertsIfAbsent,
  findPersonSite,
  insertCardImage,
  replaceCardPhotos,
  insertVerification,
  lookupPostalCode,
  listCardsForPerson,
  replaceCurrentCard,
  type Tx,
} from "@zairyu/db";
import { cardDetailsUpdateInput, cardPhotoReplaceInput, cardRegisterInput, cardVerifyInput, RETIRE_REASON_LABEL, RETIRE_REASONS, type RetireReason, icReadPayload, jstDate, needsReviewNotice } from "@zairyu/shared";
import { cardNumberHmac, decryptAddress, decryptCardNumber, encryptAddress, encryptCardNumber, putEncryptedBlob } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { assertSiteAccess } from "../authz/guards.js";
import { canAccessSite, type Actor } from "../authz/permissions.js";
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
  birthDate: z.string().nullable(),
  sex: z.string().nullable(),
  nationality: z.string().nullable(),
});

const diffOutput = z.object({
  field: z.enum(["cardNumber", "expiryDate", "cardValidUntil", "statusOfResidence", "workRestriction", "pendingApplication", "birthDate"]),
  ic: z.union([z.string(), z.boolean()]).nullable(),
  input: z.union([z.string(), z.boolean()]).nullable(),
});

async function loadCurrentCardForWrite(tx: Tx, actor: Actor, cardId: string, notCurrentMessage = "現在のカードだけ再検証できます") {
  const card = await getCardWithSite(tx, cardId);
  if (!card) throw notFound();
  assertSiteAccess(actor, card.siteId);
  if (!card.isCurrent) throw new TRPCError({ code: "BAD_REQUEST", message: notCurrentMessage });
  return card;
}

/** AB12345678CD → AB******78CD(全桁は revealCardNumber で表示し、監査ログに残す) */
export function maskCardNumber(n: string): string {
  return n.length === 12 ? `${n.slice(0, 2)}******${n.slice(8)}` : "*".repeat(n.length);
}

/** 再検証で IC から更新する項目(カードの交付後に IC へ追記されるもの) */
const REVERIFY_FIELDS = ["pendingApplication", "outsideActivity", "outsideActivityUntil"] as const;

const sameCardOutput = z.object({
  /** 担当外の拠点の人は null(社員番号・拠点名・状態だけ) */
  personId: z.string().nullable(),
  employeeCode: z.string(),
  name: z.string().nullable(),
  siteName: z.string(),
  status: z.enum(["active", "retired", "archived"]),
  retiredAt: z.string().nullable(),
  /** そのカードがその人の今のカードか(false なら過去のカード) */
  isCurrentCard: z.boolean(),
  /** 前回の退職(担当外の拠点の人は null) */
  lastEmployment: z.object({ retiredAt: z.string(), reasonCode: z.enum(RETIRE_REASONS), reasonNote: z.string().nullable() }).nullable(),
});
type SameCard = z.infer<typeof sameCardOutput>;

/** 同じカード番号を持つほかの登録者(番号はカード 1 枚ごとに違うので、一致すれば同一人物) */
async function sameCardPersons(tx: Tx, actor: Actor, numberHmac: Buffer, personId: string): Promise<SameCard[]> {
  const rows = await findPersonsWithCard(tx, numberHmac, personId);
  const visibleIds = rows.filter((r) => canAccessSite(actor, r.siteId)).map((r) => r.personId);
  const employments = await listEmployments(tx, visibleIds);
  return rows.map((r) => {
    const visible = canAccessSite(actor, r.siteId);
    const last = visible ? employments.find((e) => e.personId === r.personId) : undefined;
    return {
      personId: visible ? r.personId : null,
      employeeCode: r.employeeCode,
      name: visible ? r.name : null,
      siteName: r.siteName,
      status: r.status,
      retiredAt: r.retiredAt,
      isCurrentCard: r.isCurrentCard,
      lastEmployment: last ? { retiredAt: last.retiredAt, reasonCode: last.reasonCode as RetireReason, reasonNote: last.reasonNote } : null,
    };
  });
}

/**
 * 在籍中の別の登録者のカードなら二重登録、退職者のカードなら再入社として扱うよう止める。
 * アーカイブ済み(保存期間内の古い記録)は参考にとどめ、止めない
 */
function assertNoSameCardConflict(matches: readonly SameCard[]) {
  const active = matches.find((m) => m.status === "active");
  if (active) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `二重登録の疑い: この在留カードは在籍中の登録者(${active.siteName} ${active.employeeCode})に登録されています。異動の場合は、その登録者の拠点を変更してください`,
    });
  }
  const retired = matches.find((m) => m.status === "retired");
  if (retired) {
    const reason = retired.lastEmployment
      ? `(前回の退職: ${retired.lastEmployment.retiredAt}・${RETIRE_REASON_LABEL[retired.lastEmployment.reasonCode]}${retired.lastEmployment.reasonNote ? `・${retired.lastEmployment.reasonNote}` : ""})`
      : "";
    throw new TRPCError({
      code: "CONFLICT",
      message: `この在留カードは以前在籍していた方(${retired.siteName} ${retired.employeeCode})のものです${reason}。新しい登録者ではなく、その登録者を再入社にしてからカードを登録してください`,
    });
  }
}

export const cardsRouter = router({
  /** IC 再検証(1-8)の準備: IC の認証に使う番号を返す(番号の表示として監査ログに残す) */
  reverifyStart: permissionProcedure("cards.write")
    .input(z.object({ cardId: z.uuid() }))
    .output(z.object({ cardNumber: z.string(), cardFormat: z.enum(["legacy", "gen2", "tokutei"]) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCardForWrite(tx, ctx.actor, input.cardId);
        const cardNumber = await decryptCardNumber(requireVault(ctx.services).keyring, ctx.actor.tenantId, card.cardNumberEnc);
        await ctx.audit(tx, { action: "card.reveal_number", targetType: "residence_card", targetId: card.id, detail: { purpose: "ic_reverify" } });
        return { cardNumber, cardFormat: card.cardFormat };
      }),
    ),

  /**
   * IC 再検証(1-8): 登録済みのカードの IC を読み直して署名を検証し、確認履歴に追記する。
   * 交付後に IC へ追記される項目(更新申請中・資格外活動・裏面の住居地)が変わっていればカードに反映する
   */
  reverifyIc: permissionProcedure("cards.write")
    .input(z.object({ cardId: z.uuid(), ic: icReadPayload, deviceId: z.string().max(100).optional() }))
    .output(
      z.object({
        signature: z.enum(["valid", "invalid", "absent"]),
        /** 入管庁の発行者証明書で確かめられたか(null は該当する証明書なし。署名が有効なときだけ意味がある) */
        issuerTrusted: z.boolean().nullable(),
        icVerified: z.boolean(),
        needsReview: z.boolean(),
        changes: z.array(z.object({ field: z.string(), before: z.union([z.string(), z.boolean()]).nullable(), after: z.union([z.string(), z.boolean()]).nullable() })),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCardForWrite(tx, ctx.actor, input.cardId);
        const ic = evaluateIc(input.ic, ctx.services.config.trustedIssuers);
        // 別のカードを読んでいないか(第2世代・特定は IC 内の番号で確かめる。旧様式は番号による IC の認証が通ったことで確かめられる)
        const stored = await decryptCardNumber(requireVault(ctx.services).keyring, ctx.actor.tenantId, card.cardNumberEnc);
        if (ic.format !== card.cardFormat || (ic.cardNumber !== null && ic.cardNumber !== stored)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "登録済みのカードと違うカードが読み取られました" });
        }
        const judged = judgeSignature(ic.signature);
        const current = (await getCardState(tx, card.id))!;
        const patch: CardPatch = {};
        const changes: { field: string; before: string | boolean | null; after: string | boolean | null }[] = [];
        // 署名が NG の IC の内容は信用しないので、項目は更新しない
        if (judged.result !== "failed") {
          for (const f of REVERIFY_FIELDS) {
            const after = ic.fields[f];
            if (after === null || after === current[f]) continue;
            changes.push({ field: f, before: current[f], after });
            (patch as Record<string, unknown>)[f] = after;
          }
          if (patch.pendingApplication === true) patch.pendingApplicationSince = jstDate(ctx.services.now());
          if (patch.pendingApplication === false) patch.pendingApplicationSince = null;
          // 裏面に新しい住居地が追記されていれば、そちらに更新する(変更の記録には値を残さない)
          if (ic.backAddress) {
            const keyring = requireVault(ctx.services).keyring;
            const before = card.addressEnc ? await decryptAddress(keyring, ctx.actor.tenantId, card.addressEnc) : null;
            if (before !== ic.backAddress.address || card.addressWrittenAt !== ic.backAddress.writtenAt) {
              patch.addressEnc = await encryptAddress(keyring, ctx.actor.tenantId, ic.backAddress.address);
              patch.addressSource = "ic_back";
              patch.addressWrittenAt = ic.backAddress.writtenAt;
              patch.postalCode = (await lookupPostalCode(tx, ic.backAddress.address)).postalCode;
              changes.push({ field: "address", before: null, after: null });
            }
          }
        }
        if (judged.icVerified) patch.icVerified = true;
        if (judged.needsReview) {
          patch.icVerified = false;
          patch.needsReview = true;
        }
        if (Object.keys(patch).length > 0) await updateCard(tx, card.id, patch);
        await insertVerification(tx, {
          cardId: card.id,
          method: "ic_signature",
          result: judged.result,
          diffJson: { signature: ic.signature, reverify: true, ...(changes.length ? { changes } : {}) },
          performedBy: ctx.actor.userId,
          deviceId: input.deviceId ?? null,
        });
        if (judged.needsReview) {
          await insertAlertsIfAbsent(tx, [{ personId: card.personId, cardId: card.id, type: "needs_review", dueDate: jstDate(ctx.services.now()) }]);
          const recipients = (await alertRecipients(tx, card.siteId)).map((r) => r.id);
          await enqueueNotifications(tx, recipients, needsReviewNotice(), new Date(ctx.services.now()));
        }
        await ctx.audit(tx, {
          action: "card.ic_reverify",
          targetType: "residence_card",
          targetId: card.id,
          detail: { signature: ic.signature.status, changed: changes.map((c) => c.field) },
        });
        const issuerTrusted = ic.signature.status === "valid" ? ic.signature.issuerTrusted : null;
        return { signature: ic.signature.status, issuerTrusted, icVerified: judged.icVerified, needsReview: judged.needsReview, changes };
      }),
    ),

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
        /** 裏面に追記された住居地(旧様式の IC。あれば保存時にこちらを採用する) */
        icBackAddress: z.object({ address: z.string(), writtenAt: z.string().nullable() }).nullable(),
        /** 同じカード番号を持つほかの登録者(今のカード・過去のカード) */
        sameCard: z.array(sameCardOutput),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        await loadActivePerson(tx, ctx.actor, input.personId);
        const ic = evaluateIc(input.ic, ctx.services.config.trustedIssuers);
        const sameCard = await sameCardPersons(tx, ctx.actor, await cardNumberHmac(requireVault(ctx.services).keyring, ctx.actor.tenantId, input.cardNumber), input.personId);
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
          icBackAddress: ic.backAddress,
          sameCard,
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
      const ic = input.ic ? evaluateIc(input.ic, ctx.services.config.trustedIssuers) : null;
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
      // 住居地: 裏面に新しい住所(IC の裏面追記)があればそちらを採用し、無ければ端末の読み取り・入力を使う
      const address = ic?.backAddress
        ? { address: ic.backAddress.address, source: "ic_back" as const, writtenAt: ic.backAddress.writtenAt }
        : input.manual.address
          ? { address: input.manual.address, source: input.manual.addressSource ?? "manual", writtenAt: null }
          : null;
      const [numberEnc, numberHmac, addressEnc] = await Promise.all([
        encryptCardNumber(vault.keyring, tenantId, input.cardNumber),
        cardNumberHmac(vault.keyring, tenantId, input.cardNumber),
        address ? encryptAddress(vault.keyring, tenantId, address.address) : Promise.resolve(null),
      ]);
      const images = [
        ...(ic?.images ?? []),
        ...(input.photos.front ? [{ kind: "front" as const, contentType: input.photos.front.contentType, data: Buffer.from(input.photos.front.data, "base64") }] : []),
        ...(input.photos.back ? [{ kind: "back" as const, contentType: input.photos.back.contentType, data: Buffer.from(input.photos.back.data, "base64") }] : []),
      ];
      const stored = await Promise.all(
        images.map(async (img) => ({ ...img, blobKey: await putEncryptedBlob(vault.blobs, vault.keyring, tenantId, img.data) })),
      );
      // 登録に失敗した場合に残った Blob は、削除ジョブ(worker purge)が 24 時間後以降に掃除する

      return ctx.tenantTx(async (tx) => {
        const person = await loadActivePerson(tx, ctx.actor, input.personId);
        // 同じカード番号(今のカード・過去のカード)を持つほかの登録者がいれば同一人物
        assertNoSameCardConflict(await sameCardPersons(tx, ctx.actor, numberHmac, input.personId));
        const today = jstDate(ctx.services.now());
        // 郵便番号: 入力が無ければ住居地から引く(1 つに決まったときだけ)
        const postalCode = input.manual.postalCode ?? (address ? (await lookupPostalCode(tx, address.address)).postalCode : null);
        const cardId = await replaceCurrentCard(tx, input.personId, {
          postalCode,
          cardFormat: ic?.format ?? "legacy",
          cardKind: ic?.kind ?? "residence",
          cardNumberEnc: numberEnc,
          cardNumberHmac: numberHmac,
          addressEnc,
          addressSource: address?.source ?? null,
          addressWrittenAt: address?.writtenAt ?? null,
          ...fields,
          pendingApplication: fields.pendingApplication ?? false,
          pendingApplicationSince: fields.pendingApplication ? today : null,
          icVerified: judged.icVerified,
          needsReview: judged.needsReview,
        });
        const filled = await fillPersonFromCard(tx, input.personId, { birthDate: fields.birthDate, nationality: fields.nationality });
        if (filled.length > 0) await ctx.audit(tx, { action: "person.update", targetType: "person", targetId: input.personId, detail: { via: "card_register", fields: filled } });
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
          detail: { personId: input.personId, format: ic?.format ?? null, icVerified: judged.icVerified, needsReview: judged.needsReview, images: stored.map((i) => i.kind), addressSource: address?.source ?? null },
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
          /** 在留カード番号(中ほどを伏せた表示。全桁は revealCardNumber で、監査ログに残る) */
          cardNumberMasked: z.string(),
          /** 住居地(復号済み)。出どころ: ic_back / back_photo / front_photo / manual */
          address: z.string().nullable(),
          addressSource: z.string().nullable(),
          addressWrittenAt: z.string().nullable(),
          /** 郵便番号(7 桁) */
          postalCode: z.string().nullable(),
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
        const keyring = requireVault(ctx.services).keyring;
        return Promise.all(
          cards.map(async ({ cardNumberEnc, addressEnc, ...c }) => ({
            ...c,
            cardNumberMasked: maskCardNumber(await decryptCardNumber(keyring, ctx.actor.tenantId, cardNumberEnc)),
            address: addressEnc ? await decryptAddress(keyring, ctx.actor.tenantId, addressEnc) : null,
          })),
        );
      }),
    ),

  /**
   * 現在のカードの記載事項を直す(保存済みの撮影画像を端末で読み取った結果や目視で)。
   * - 第2世代・特定の券面記載事項(生年月日・性別・国籍・在留資格・満了日・有効期限)は IC の値なので変えられない
   * - IC の裏面追記から取った住居地は変えられない(IC 再検証で更新する)
   * - 変更した項目名を監査ログに、目視確認として確認履歴に残す(値は残さない)
   */
  /**
   * 撮影した表面・裏面の写真を撮り直す(ぶれ・反射で読めないときなど)。現在のカード・在籍中の登録者だけ。
   * 古い写真は消す(行はこのトランザクションで、ファイルはコミット後)。IC の画像は変えない。
   * 写真から記載事項を読み直すときは、端末で読み取ってから updateDetails で直す
   */
  replacePhotos: permissionProcedure("cards.write")
    .input(cardPhotoReplaceInput)
    .output(z.object({ replaced: z.array(z.enum(["front", "back"])) }))
    .mutation(async ({ ctx, input }) => {
      const vault = requireVault(ctx.services);
      const tenantId = ctx.actor.tenantId;
      // 暗号化・保存はトランザクションの外で先に行う(登録と同じ。確認で止まったファイルは削除ジョブが 24 時間後以降に掃除する)
      const photos = (["front", "back"] as const).flatMap((kind) => {
        const p = input[kind];
        return p ? [{ kind, contentType: p.contentType, data: Buffer.from(p.data, "base64") }] : [];
      });
      const stored = await Promise.all(photos.map(async (p) => ({ kind: p.kind, contentType: p.contentType, blobKey: await putEncryptedBlob(vault.blobs, vault.keyring, tenantId, p.data) })));
      const oldKeys = await ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCardForWrite(tx, ctx.actor, input.cardId, "写真を撮り直せるのは現在のカードだけです");
        if (card.personStatus !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "在籍中の登録者だけ写真を撮り直せます" });
        const old = await replaceCardPhotos(tx, card.id, stored);
        await ctx.audit(tx, { action: "card.photo_replace", targetType: "residence_card", targetId: card.id, detail: { personId: card.personId, kinds: stored.map((s) => s.kind), removed: old.length } });
        return old;
      });
      // 古いファイルを消す。失敗しても記録は無いので、削除ジョブの孤立ファイル掃除で消える
      await Promise.all(oldKeys.map((k) => vault.blobs.delete(k).catch(() => undefined)));
      return { replaced: stored.map((s) => s.kind) };
    }),

  updateDetails: permissionProcedure("cards.write")
    .input(cardDetailsUpdateInput)
    .output(z.object({ changed: z.array(z.string()) }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await loadCurrentCardForWrite(tx, ctx.actor, input.cardId, "記載事項を直せるのは現在のカードだけです");
        const fromIc = card.cardFormat !== "legacy";
        const icOnly = ["birthDate", "sex", "nationality", "statusOfResidence", "expiryDate", "cardValidUntil"] as const;
        if (fromIc && icOnly.some((k) => input[k] !== undefined)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "第2世代のカードの記載事項は IC の値を使うため変更できません" });
        }
        if (input.address !== undefined && card.addressSource === "ic_back") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "IC の裏面記載から読み取った住居地は変更できません(IC の再検証で更新されます)" });
        }
        const status = input.statusOfResidence !== undefined ? input.statusOfResidence : card.statusOfResidence;
        const expiry = input.expiryDate !== undefined ? input.expiryDate : card.expiryDate;
        if (/永住者/.test(status ?? "") && expiry) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "永住者には在留期間の満了日がありません。券面の日付は「カードの有効期限」として入力してください" });
        }
        const patch: CardPatch = {};
        const changed: string[] = [];
        for (const k of icOnly) {
          const v = input[k];
          if (v === undefined || v === card[k]) continue;
          (patch as Record<string, unknown>)[k] = v;
          changed.push(k);
        }
        if (input.address !== undefined) {
          const keyring = requireVault(ctx.services).keyring;
          const before = card.addressEnc ? await decryptAddress(keyring, ctx.actor.tenantId, card.addressEnc) : null;
          if ((input.address || null) !== before) {
            patch.addressEnc = input.address ? await encryptAddress(keyring, ctx.actor.tenantId, input.address) : null;
            patch.addressSource = input.address ? (input.addressSource ?? "manual") : null;
            patch.addressWrittenAt = null;
            changed.push("address");
            // 住居地を変えて郵便番号の指定が無ければ、新しい住居地から引き直す
            if (input.postalCode === undefined) patch.postalCode = input.address ? (await lookupPostalCode(tx, input.address)).postalCode : null;
          }
        }
        if (input.postalCode !== undefined && input.postalCode !== card.postalCode) patch.postalCode = input.postalCode;
        if (patch.postalCode !== undefined && patch.postalCode !== card.postalCode) changed.push("postalCode");
        if (changed.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "変更された項目がありません" });
        await updateCard(tx, card.id, patch);
        await insertVerification(tx, {
          cardId: card.id,
          method: "visual",
          result: "ok",
          diffJson: { corrected: changed },
          note: "記載事項の修正",
          performedBy: ctx.actor.userId,
        });
        await ctx.audit(tx, { action: "card.update_details", targetType: "residence_card", targetId: card.id, detail: { fields: changed, addressSource: input.addressSource ?? null } });
        return { changed };
      }),
    ),

  /** 在留カード番号を全桁で表示する(監査ログに残す) */
  revealCardNumber: permissionProcedure("cards.viewImage")
    .input(z.object({ cardId: z.uuid() }))
    .output(z.object({ cardNumber: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.tenantTx(async (tx) => {
        const card = await getCardWithSite(tx, input.cardId);
        if (!card) throw notFound();
        assertSiteAccess(ctx.actor, card.siteId);
        const cardNumber = await decryptCardNumber(requireVault(ctx.services).keyring, ctx.actor.tenantId, card.cardNumberEnc);
        await ctx.audit(tx, { action: "card.reveal_number", targetType: "residence_card", targetId: card.id, detail: { purpose: "view" } });
        return { cardNumber };
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
