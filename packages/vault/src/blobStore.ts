/**
 * ファイル(カード画像)の保存先。中身はすべて暗号化済みのバイト列を渡す(encryptedBlobs.ts)。
 * - AzureBlobStore: 本番(非公開コンテナ、マネージド ID)
 * - FsBlobStore: 開発用
 * - MemoryBlobStore: テスト用
 * キーは "<テナントID>/<UUID>" とし、テナント単位で削除・移行できるようにする
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** 無ければ null */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** テナントのファイルの一覧(孤立したファイルの掃除に使う) */
  list(tenantId: string): AsyncIterable<BlobEntry>;
}

export interface BlobEntry {
  key: string;
  lastModified: Date;
}

const TENANT_RE = /^[0-9a-f-]{36}$/;
function assertTenantId(tenantId: string): void {
  if (!TENANT_RE.test(tenantId)) throw new Error("テナント ID が不正です");
}

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-zA-Z_-]{1,64}$/;

export function assertBlobKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error("Blob のキーが不正です");
}

export class MemoryBlobStore implements BlobStore {
  readonly data = new Map<string, Buffer>();
  readonly modified = new Map<string, Date>();
  constructor(private readonly now: () => number = Date.now) {}
  async put(key: string, data: Buffer) {
    assertBlobKey(key);
    this.data.set(key, Buffer.from(data));
    this.modified.set(key, new Date(this.now()));
  }
  async get(key: string) {
    assertBlobKey(key);
    return this.data.get(key) ?? null;
  }
  async delete(key: string) {
    assertBlobKey(key);
    this.data.delete(key);
    this.modified.delete(key);
  }
  async *list(tenantId: string) {
    assertTenantId(tenantId);
    for (const key of [...this.data.keys()].filter((k) => k.startsWith(`${tenantId}/`))) {
      yield { key, lastModified: this.modified.get(key) ?? new Date(0) };
    }
  }
}

export class FsBlobStore implements BlobStore {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    assertBlobKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("Blob のキーが不正です");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async *list(tenantId: string) {
    assertTenantId(tenantId);
    let names: string[];
    try {
      names = await readdir(join(this.root, tenantId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of names) {
      const key = `${tenantId}/${name}`;
      if (!KEY_RE.test(key)) continue;
      yield { key, lastModified: (await stat(this.path(key))).mtime };
    }
  }
}

export class AzureBlobStore implements BlobStore {
  private readonly container: ContainerClient;
  constructor(accountUrl: string, containerName: string, credential: TokenCredential = new DefaultAzureCredential()) {
    this.container = new BlobServiceClient(accountUrl, credential).getContainerClient(containerName);
  }
  async put(key: string, data: Buffer) {
    assertBlobKey(key);
    await this.container.getBlockBlobClient(key).uploadData(data, {
      blobHTTPHeaders: { blobContentType: "application/octet-stream" },
    });
  }
  async get(key: string) {
    assertBlobKey(key);
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }
  async delete(key: string) {
    assertBlobKey(key);
    await this.container.getBlockBlobClient(key).deleteIfExists();
  }
  async *list(tenantId: string) {
    assertTenantId(tenantId);
    for await (const b of this.container.listBlobsFlat({ prefix: `${tenantId}/` })) {
      if (KEY_RE.test(b.name)) yield { key: b.name, lastModified: b.properties.lastModified };
    }
  }
}
