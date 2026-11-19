import { TRPCError } from "@trpc/server";
import { canAccessSite, type Actor } from "./permissions.js";

/**
 * 拠点の範囲外ならエラー。存在を推測させないよう NOT_FOUND にする
 */
export function assertSiteAccess(actor: Actor, siteId: string): void {
  if (!canAccessSite(actor, siteId)) throw new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });
}
