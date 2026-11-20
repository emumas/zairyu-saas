/**
 * カード画像の配信。
 * - URL の発行(=閲覧)時に権限・拠点の範囲を確認し、監査ログに記録する
 * - URL は API 自身の短命な署名付き URL。Blob の SAS は使わない(Blob 上は暗号文のため)
 * - 配信時に復号し、キャッシュさせない
 */
import { schema, withTenant, type Tx } from "@zairyu/db";
import { getDecryptedBlob } from "@zairyu/vault";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { signToken, verifyToken } from "./auth/tokens.js";
import { assertSiteAccess } from "./authz/guards.js";
import type { Actor } from "./authz/permissions.js";
import { requireVault, type Services } from "./trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

export async function issueImageUrl(
  services: Services,
  tx: Tx,
  actor: Actor,
  imageId: string,
  audit: (tx: Tx, e: { action: string; targetType: string; targetId: string }) => Promise<void>,
): Promise<{ url: string; expiresIn: number }> {
  const [row] = await tx
    .select({ id: schema.cardImages.id, siteId: schema.persons.siteId })
    .from(schema.cardImages)
    .innerJoin(schema.residenceCards, eq(schema.residenceCards.id, schema.cardImages.cardId))
    .innerJoin(schema.persons, eq(schema.persons.id, schema.residenceCards.personId))
    .where(eq(schema.cardImages.id, imageId));
  if (!row) throw notFound();
  assertSiteAccess(actor, row.siteId);
  await audit(tx, { action: "card_image.view", targetType: "card_image", targetId: imageId });
  const ttl = services.config.imageUrlTtlSec;
  const token = await signToken(
    services.config.jwtSecret,
    { userId: actor.userId, tenantId: actor.tenantId, type: "image", resource: imageId },
    ttl,
    Math.floor(services.now() / 1000),
  );
  return { url: `${services.config.publicBaseUrl}/files/images/${token}`, expiresIn: ttl };
}

export interface FileResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const NO_STORE = {
  "Cache-Control": "no-store, private",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** GET /files/images/<token> */
export async function serveImage(services: Services, token: string): Promise<FileResponse> {
  const missing: FileResponse = { status: 404, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from("見つかりません") };
  const claims = await verifyToken(services.config.jwtSecret, token, "image", Math.floor(services.now() / 1000));
  if (!claims?.resource) return missing;
  const vault = requireVault(services);
  const image = await withTenant(services.db, claims.tenantId, async (tx) => {
    const [row] = await tx
      .select({ blobKey: schema.cardImages.blobKey, contentType: schema.cardImages.contentType })
      .from(schema.cardImages)
      .where(eq(schema.cardImages.id, claims.resource!));
    return row ?? null;
  });
  if (!image) return missing;
  const body = await getDecryptedBlob(vault.blobs, vault.keyring, claims.tenantId, image.blobKey);
  if (!body) return missing;
  return {
    status: 200,
    headers: { ...NO_STORE, "Content-Type": image.contentType, "Content-Disposition": "inline", "Content-Length": String(body.length) },
    body,
  };
}
