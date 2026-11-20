/** 招待リンクの発行(組織管理 1-15 と運営者コンソール 1-19 で共通) */
import { enqueueNotifications, insertInvitation, type Tx } from "@zairyu/db";
import { inviteNotice, jstDate } from "@zairyu/shared";
import { hashRefreshToken, newRefreshToken } from "./auth/tokens.js";
import type { Services } from "./trpc.js";

/**
 * 招待を発行し、招待メールを送信待ちに積む。tenantTx / withTenant のトランザクションで呼ぶこと。
 * createdBy はテナントのユーザー(運営者が発行したときは null)
 */
export async function issueInvitation(services: Services, tx: Tx, v: { tenantId: string; userId: string; email: string; createdBy: string | null }) {
  const token = newRefreshToken(v.tenantId);
  const expiresAt = new Date(services.now() + services.config.invitationTtlSec * 1000);
  await insertInvitation(tx, { userId: v.userId, tokenHash: hashRefreshToken(token), expiresAt, createdBy: v.createdBy });
  // トークンは URL のフラグメントに入れる(サーバーのログやリファラーに残さない)
  const inviteUrl = `${services.config.webBaseUrl}/invite#${token}`;
  await enqueueNotifications(tx, [v.userId], inviteNotice(inviteUrl, jstDate(expiresAt.getTime())), new Date(services.now()), ["email"]);
  return { inviteUrl, expiresAt, email: v.email };
}
