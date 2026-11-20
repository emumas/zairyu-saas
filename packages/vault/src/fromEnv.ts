/** 環境変数から鍵の提供元と保存先を作る */
import type { Db } from "@zairyu/db";
import { AzureBlobStore, FsBlobStore, MemoryBlobStore, type BlobStore } from "./blobStore.js";
import { AzureKeyVaultKeyProvider, LocalKeyProvider, type KeyProvider } from "./keyProvider.js";
import { TenantKeyring } from "./keyring.js";

export interface Vault {
  keyring: TenantKeyring;
  blobs: BlobStore;
}

/**
 * VAULT_KEY_PROVIDER=azure → AZURE_KEY_VAULT_KEY_ID(本番)
 * VAULT_KEY_PROVIDER=local → VAULT_LOCAL_KEK(base64 32 バイト。開発用)
 * BLOB_STORE=azure → AZURE_STORAGE_ACCOUNT_URL, AZURE_STORAGE_CONTAINER(本番)
 * BLOB_STORE=fs → BLOB_FS_DIR(開発用) / memory(テスト用)
 */
export function createVaultFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): Vault {
  let provider: KeyProvider;
  switch (env.VAULT_KEY_PROVIDER) {
    case "azure":
      provider = new AzureKeyVaultKeyProvider(required(env, "AZURE_KEY_VAULT_KEY_ID"));
      break;
    case "local": {
      const kek = Buffer.from(required(env, "VAULT_LOCAL_KEK"), "base64");
      provider = new LocalKeyProvider({ v1: kek });
      break;
    }
    default:
      throw new Error("VAULT_KEY_PROVIDER に azure か local を指定してください");
  }
  let blobs: BlobStore;
  switch (env.BLOB_STORE) {
    case "azure":
      blobs = new AzureBlobStore(required(env, "AZURE_STORAGE_ACCOUNT_URL"), required(env, "AZURE_STORAGE_CONTAINER"));
      break;
    case "fs":
      blobs = new FsBlobStore(required(env, "BLOB_FS_DIR"));
      break;
    case "memory":
      blobs = new MemoryBlobStore();
      break;
    default:
      throw new Error("BLOB_STORE に azure / fs / memory のいずれかを指定してください");
  }
  return { keyring: new TenantKeyring(db, provider), blobs };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} を設定してください`);
  return v;
}
