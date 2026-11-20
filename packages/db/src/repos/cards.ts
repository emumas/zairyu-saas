/** カード・画像・確認履歴のリポジトリ(withTenant のトランザクションで呼ぶこと) */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "../client.js";
import { cardImages, persons, residenceCards, verifications } from "../schema.js";

export type NewCard = Omit<typeof residenceCards.$inferInsert, "id" | "tenantId" | "personId" | "isCurrent" | "createdAt" | "updatedAt">;

/** 別の登録者の「現在のカード」に同じ番号(HMAC)があるか */
export async function findOtherPersonWithCard(tx: Tx, cardNumberHmac: Buffer, personId: string): Promise<string | null> {
  const [row] = await tx
    .select({ personId: residenceCards.personId })
    .from(residenceCards)
    .innerJoin(persons, eq(persons.id, residenceCards.personId))
    .where(
      and(
        eq(residenceCards.cardNumberHmac, cardNumberHmac),
        eq(residenceCards.isCurrent, true),
        ne(residenceCards.personId, personId),
        ne(persons.status, "archived"),
      ),
    )
    .limit(1);
  return row?.personId ?? null;
}

/** 現在のカードを置き換える(以前のカードは履歴として残す) */
export async function replaceCurrentCard(tx: Tx, personId: string, card: NewCard): Promise<string> {
  await tx
    .update(residenceCards)
    .set({ isCurrent: false, updatedAt: new Date() })
    .where(and(eq(residenceCards.personId, personId), eq(residenceCards.isCurrent, true)));
  const [row] = await tx
    .insert(residenceCards)
    .values({ ...card, personId, isCurrent: true })
    .returning({ id: residenceCards.id });
  return row!.id;
}

export async function getCurrentCard(tx: Tx, personId: string) {
  const [row] = await tx
    .select()
    .from(residenceCards)
    .where(and(eq(residenceCards.personId, personId), eq(residenceCards.isCurrent, true)));
  return row ?? null;
}

export async function insertCardImage(
  tx: Tx,
  v: { cardId: string; kind: (typeof cardImages.$inferInsert)["kind"]; blobKey: string; contentType: string },
): Promise<string> {
  const [row] = await tx.insert(cardImages).values(v).returning({ id: cardImages.id });
  return row!.id;
}

export async function insertVerification(
  tx: Tx,
  v: Omit<typeof verifications.$inferInsert, "id" | "tenantId" | "performedAt">,
): Promise<string> {
  const [row] = await tx.insert(verifications).values(v).returning({ id: verifications.id });
  return row!.id;
}

/** 登録者のカード履歴(新しい順)。番号の暗号文は含めない */
export async function listCardsForPerson(tx: Tx, personId: string) {
  const cards = await tx
    .select({
      id: residenceCards.id,
      cardFormat: residenceCards.cardFormat,
      cardKind: residenceCards.cardKind,
      statusOfResidence: residenceCards.statusOfResidence,
      periodOfStay: residenceCards.periodOfStay,
      permissionType: residenceCards.permissionType,
      permittedAt: residenceCards.permittedAt,
      expiryDate: residenceCards.expiryDate,
      cardValidUntil: residenceCards.cardValidUntil,
      workRestriction: residenceCards.workRestriction,
      outsideActivity: residenceCards.outsideActivity,
      outsideActivityUntil: residenceCards.outsideActivityUntil,
      pendingApplication: residenceCards.pendingApplication,
      birthDate: residenceCards.birthDate,
      sex: residenceCards.sex,
      nationality: residenceCards.nationality,
      cardNumberEnc: residenceCards.cardNumberEnc,
      addressEnc: residenceCards.addressEnc,
      addressSource: residenceCards.addressSource,
      addressWrittenAt: residenceCards.addressWrittenAt,
      icVerified: residenceCards.icVerified,
      needsReview: residenceCards.needsReview,
      isCurrent: residenceCards.isCurrent,
      createdAt: residenceCards.createdAt,
    })
    .from(residenceCards)
    .where(eq(residenceCards.personId, personId))
    .orderBy(desc(residenceCards.createdAt));
  const ids = cards.map((c) => c.id);
  if (ids.length === 0) return [];
  const [imgs, vers] = await Promise.all([
    tx.select({ id: cardImages.id, cardId: cardImages.cardId, kind: cardImages.kind }).from(cardImages).where(inArray(cardImages.cardId, ids)),
    tx
      .select({
        id: verifications.id,
        cardId: verifications.cardId,
        method: verifications.method,
        result: verifications.result,
        note: verifications.note,
        performedBy: verifications.performedBy,
        performedAt: verifications.performedAt,
      })
      .from(verifications)
      .where(inArray(verifications.cardId, ids))
      .orderBy(desc(verifications.performedAt)),
  ]);
  return cards.map((c) => ({
    ...c,
    images: imgs.filter((i) => i.cardId === c.id).map(({ id, kind }) => ({ id, kind })),
    verifications: vers.filter((v) => v.cardId === c.id),
  }));
}

/** カードと、その登録者の拠点(権限の確認用) */
export async function getCardWithSite(tx: Tx, cardId: string) {
  const [row] = await tx
    .select({
      id: residenceCards.id,
      personId: residenceCards.personId,
      siteId: persons.siteId,
      cardFormat: residenceCards.cardFormat,
      cardNumberEnc: residenceCards.cardNumberEnc,
      addressEnc: residenceCards.addressEnc,
      addressWrittenAt: residenceCards.addressWrittenAt,
      expiryDate: residenceCards.expiryDate,
      cardValidUntil: residenceCards.cardValidUntil,
      isCurrent: residenceCards.isCurrent,
    })
    .from(residenceCards)
    .innerJoin(persons, eq(persons.id, residenceCards.personId))
    .where(eq(residenceCards.id, cardId));
  return row ?? null;
}

export async function markCardNeedsReview(tx: Tx, cardId: string): Promise<void> {
  await tx.update(residenceCards).set({ needsReview: true, updatedAt: new Date() }).where(eq(residenceCards.id, cardId));
}

export type CardPatch = Partial<
  Pick<
    typeof residenceCards.$inferInsert,
    | "pendingApplication"
    | "pendingApplicationSince"
    | "outsideActivity"
    | "outsideActivityUntil"
    | "icVerified"
    | "needsReview"
    | "addressEnc"
    | "addressSource"
    | "addressWrittenAt"
  >
>;

export async function updateCard(tx: Tx, cardId: string, patch: CardPatch): Promise<void> {
  await tx.update(residenceCards).set({ ...patch, updatedAt: new Date() }).where(eq(residenceCards.id, cardId));
}

/** 再検証で比べるための現在の値 */
export async function getCardState(tx: Tx, cardId: string) {
  const [row] = await tx
    .select({
      pendingApplication: residenceCards.pendingApplication,
      outsideActivity: residenceCards.outsideActivity,
      outsideActivityUntil: residenceCards.outsideActivityUntil,
      icVerified: residenceCards.icVerified,
    })
    .from(residenceCards)
    .where(eq(residenceCards.id, cardId));
  return row ?? null;
}
