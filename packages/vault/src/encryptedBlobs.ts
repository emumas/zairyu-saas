/** 暗号化してから Blob に置く / 取り出して復号する */
import { randomUUID } from "node:crypto";
import type { BlobStore } from "./blobStore.js";
import { decryptField, encryptField } from "./fieldCipher.js";
import type { TenantKeyring } from "./keyring.js";

const context = (key: string) => `blob:${key}`;

export async function putEncryptedBlob(store: BlobStore, keyring: TenantKeyring, tenantId: string, data: Uint8Array): Promise<string> {
  const key = `${tenantId}/${randomUUID()}`;
  await store.put(key, await encryptField(keyring, tenantId, data, context(key)));
  return key;
}

export async function getDecryptedBlob(store: BlobStore, keyring: TenantKeyring, tenantId: string, key: string): Promise<Buffer | null> {
  // 別テナントのキーを渡されても読まない(RLS で行が見えない前提に加えた二重の防御)
  if (!key.startsWith(`${tenantId}/`)) return null;
  const sealed = await store.get(key);
  return sealed ? decryptField(keyring, tenantId, sealed, context(key)) : null;
}
