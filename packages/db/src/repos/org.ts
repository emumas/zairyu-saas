/** 組織(拠点・ユーザー・招待)のリポジトリ(withTenant のトランザクションで呼ぶこと) */
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import type { Tx } from "../client.js";
import { refreshTokens, sites, userInvitations, userSites, users } from "../schema.js";

export async function listSites(tx: Tx) {
  return tx
    .select({
      id: sites.id,
      name: sites.name,
      archivedAt: sites.archivedAt,
      createdAt: sites.createdAt,
      officialName: sites.officialName,
      address: sites.address,
      phone: sites.phone,
      insuranceOfficeNumber: sites.insuranceOfficeNumber,
    })
    .from(sites)
    .orderBy(asc(sites.name));
}

export async function createSite(tx: Tx, name: string): Promise<string> {
  const [row] = await tx.insert(sites).values({ name }).returning({ id: sites.id });
  return row!.id;
}

export async function updateSite(
  tx: Tx,
  id: string,
  patch: { name?: string; archivedAt?: Date | null; officialName?: string | null; address?: string | null; phone?: string | null; insuranceOfficeNumber?: string | null },
): Promise<boolean> {
  const rows = await tx.update(sites).set(patch).where(eq(sites.id, id)).returning({ id: sites.id });
  return rows.length > 0;
}

export async function listUsers(tx: Tx) {
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      totpEnabled: users.totpEnabled,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.email));
  const links = await tx.select({ userId: userSites.userId, siteId: userSites.siteId }).from(userSites);
  return rows.map((u) => ({ ...u, siteIds: links.filter((l) => l.userId === u.id).map((l) => l.siteId) }));
}

export async function getUser(tx: Tx, id: string) {
  const [row] = await tx.select({ id: users.id, email: users.email, role: users.role, status: users.status }).from(users).where(eq(users.id, id));
  return row ?? null;
}

/** 有効なテナント管理者の数(except を除く) */
export async function countActiveTenantAdmins(tx: Tx, exceptUserId?: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "tenant_admin"), eq(users.status, "active"), exceptUserId ? ne(users.id, exceptUserId) : undefined));
  return row?.n ?? 0;
}

export async function insertInvitedUser(tx: Tx, v: { email: string; role: (typeof users.$inferInsert)["role"] }): Promise<string> {
  const [row] = await tx.insert(users).values({ email: v.email, role: v.role, status: "invited" }).returning({ id: users.id });
  return row!.id;
}

export async function setUserSites(tx: Tx, userId: string, siteIds: readonly string[]): Promise<void> {
  await tx.delete(userSites).where(eq(userSites.userId, userId));
  if (siteIds.length > 0) await tx.insert(userSites).values(siteIds.map((siteId) => ({ userId, siteId })));
}

export async function updateUser(
  tx: Tx,
  id: string,
  patch: Partial<Pick<typeof users.$inferInsert, "role" | "status" | "passwordHash" | "totpEnabled" | "totpSecretEnc" | "totpLastStep">>,
): Promise<void> {
  await tx.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id));
}

/** そのユーザーのリフレッシュトークンをすべて失効させる(利用停止・ロール変更時) */
export async function revokeUserTokens(tx: Tx, userId: string, at: Date): Promise<void> {
  await tx.update(refreshTokens).set({ revokedAt: at }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function insertInvitation(tx: Tx, v: { userId: string; tokenHash: Buffer; expiresAt: Date; createdBy: string | null }): Promise<void> {
  // 以前の未使用の招待は使えなくする
  await tx.update(userInvitations).set({ usedAt: v.expiresAt }).where(and(eq(userInvitations.userId, v.userId), isNull(userInvitations.usedAt)));
  await tx.insert(userInvitations).values(v);
}

export async function findInvitation(tx: Tx, tokenHash: Buffer) {
  const [row] = await tx.select().from(userInvitations).where(eq(userInvitations.tokenHash, tokenHash));
  return row ?? null;
}

export async function markInvitationUsed(tx: Tx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(userInvitations)
    .set({ usedAt: at })
    .where(and(eq(userInvitations.id, id), isNull(userInvitations.usedAt)))
    .returning({ id: userInvitations.id });
  return rows.length > 0;
}
