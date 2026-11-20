/**
 * 列・ファイルの暗号化(AES-256-GCM、テナントのデータ鍵)。
 * 形式: 0x01 || 鍵の版(4 バイト BE) || iv(12) || tag(16) || 暗号文
 * AAD にテナント ID と用途(context)を入れ、別テナント・別の列へ移した暗号文は復号できないようにする
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { TenantKeyring } from "./keyring.js";

const FORMAT_V1 = 0x01;
const HEADER = 1 + 4 + 12 + 16;

const aad = (tenantId: string, context: string, version: number) => Buffer.from(`${tenantId}|${context}|${version}`);

export async function encryptField(keyring: TenantKeyring, tenantId: string, plain: Uint8Array, context: string): Promise<Buffer> {
  const { version, key } = await keyring.activeDataKey(tenantId);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(tenantId, context, version));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const header = Buffer.alloc(5);
  header[0] = FORMAT_V1;
  header.writeUInt32BE(version, 1);
  return Buffer.concat([header, iv, c.getAuthTag(), ct]);
}

export async function decryptField(keyring: TenantKeyring, tenantId: string, sealed: Uint8Array, context: string): Promise<Buffer> {
  const b = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (b.length < HEADER || b[0] !== FORMAT_V1) throw new Error("暗号文の形式が不正です");
  const version = b.readUInt32BE(1);
  const key = await keyring.dataKey(tenantId, version);
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(5, 17));
  d.setAAD(aad(tenantId, context, version));
  d.setAuthTag(b.subarray(17, 33));
  return Buffer.concat([d.update(b.subarray(33)), d.final()]);
}

/** 暗号文がどの鍵の版で作られたか(ローテーション後の再暗号化の判定用) */
export function keyVersionOf(sealed: Uint8Array): number {
  return Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength).readUInt32BE(1);
}

// ---------------------------------------------------------------- カード番号

const CARD_NUMBER_CONTEXT = "residence_cards.card_number";

export function encryptCardNumber(keyring: TenantKeyring, tenantId: string, cardNumber: string): Promise<Buffer> {
  return encryptField(keyring, tenantId, Buffer.from(cardNumber, "utf8"), CARD_NUMBER_CONTEXT);
}

export async function decryptCardNumber(keyring: TenantKeyring, tenantId: string, sealed: Uint8Array): Promise<string> {
  return (await decryptField(keyring, tenantId, sealed, CARD_NUMBER_CONTEXT)).toString("utf8");
}

/**
 * カード番号の検索用 HMAC。番号は正規化(大文字・空白なし)してから渡すこと。
 * テナントごとに鍵が違うため、別テナントの同じ番号とは一致しない
 */
export async function cardNumberHmac(keyring: TenantKeyring, tenantId: string, normalizedCardNumber: string): Promise<Buffer> {
  return createHmac("sha256", await keyring.hmacKey(tenantId)).update(`card_number:${normalizedCardNumber}`).digest();
}
