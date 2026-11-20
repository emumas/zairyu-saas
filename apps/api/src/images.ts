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
import { ImageConvertError, toDisplayImage } from "./imageConvert.js";
import { requireVault, type Services } from "./trpc.js";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "対象が見つかりません" });

type AuditFn = (tx: Tx, e: { action: string; targetType: string; targetId: string }) => Promise<void>;

/** 画像の行を権限・拠点の範囲を確かめて取り出し、閲覧を監査ログに記録する */
async function loadImageRow(tx: Tx, actor: Actor, imageId: string, audit: AuditFn) {
  const [row] = await tx
    .select({
      id: schema.cardImages.id,
      kind: schema.cardImages.kind,
      blobKey: schema.cardImages.blobKey,
      contentType: schema.cardImages.contentType,
      siteId: schema.persons.siteId,
    })
    .from(schema.cardImages)
    .innerJoin(schema.residenceCards, eq(schema.residenceCards.id, schema.cardImages.cardId))
    .innerJoin(schema.persons, eq(schema.persons.id, schema.residenceCards.personId))
    .where(eq(schema.cardImages.id, imageId));
  if (!row) throw notFound();
  assertSiteAccess(actor, row.siteId);
  await audit(tx, { action: "card_image.view", targetType: "card_image", targetId: imageId });
  return row;
}

/**
 * アプリ向け: 表示用に変換した画像をデータで返す(URL にすると端末の画像キャッシュに残りうるため)
 */
export async function getDisplayImage(services: Services, tx: Tx, actor: Actor, imageId: string, audit: AuditFn) {
  const row = await loadImageRow(tx, actor, imageId, audit);
  const vault = requireVault(services);
  const raw = await getDecryptedBlob(vault.blobs, vault.keyring, actor.tenantId, row.blobKey);
  if (!raw) throw notFound();
  try {
    const img = await toDisplayImage(row.contentType, raw);
    return { kind: row.kind, contentType: img.contentType, data: img.data.toString("base64"), width: img.width, height: img.height };
  } catch (e) {
    if (e instanceof ImageConvertError) throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: e.message });
    throw e;
  }
}

export async function issueImageUrl(
  services: Services,
  tx: Tx,
  actor: Actor,
  imageId: string,
  audit: AuditFn,
): Promise<{ url: string; expiresIn: number }> {
  await loadImageRow(tx, actor, imageId, audit);
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
  const raw = await getDecryptedBlob(vault.blobs, vault.keyring, claims.tenantId, image.blobKey);
  if (!raw) return missing;
  // ブラウザで表示できる形式に変換して返す(TIFF / JPEG2000 → PNG / JPEG)
  let body: Buffer;
  let contentType: string;
  try {
    const img = await toDisplayImage(image.contentType, raw);
    body = img.data;
    contentType = img.contentType;
  } catch {
    return { status: 415, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from("この画像は表示できません") };
  }
  return {
    status: 200,
    headers: { ...NO_STORE, "Content-Type": contentType, "Content-Disposition": "inline", "Content-Length": String(body.length) },
    body,
  };
}
