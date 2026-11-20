import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore, MemoryBlobStore, assertBlobKey } from "../src/blobStore.js";
import { AzureKeyVaultKeyProvider, LocalKeyProvider } from "../src/keyProvider.js";

describe("LocalKeyProvider", () => {
  it("包んで開ける", async () => {
    const p = new LocalKeyProvider({ v1: randomBytes(32) });
    const key = randomBytes(32);
    const { kekId, wrapped } = await p.wrap(key);
    expect(kekId).toBe("local:v1");
    expect(wrapped.includes(key)).toBe(false);
    expect((await p.unwrap(kekId, wrapped)).equals(key)).toBe(true);
  });

  it("KEK のローテーション後も古い KEK で包んだ鍵を開ける", async () => {
    const old = randomBytes(32);
    const before = await new LocalKeyProvider({ v1: old }).wrap(randomBytes(32));
    const rotated = new LocalKeyProvider({ v2: randomBytes(32), v1: old });
    expect(rotated.activeKekId).toBe("local:v2");
    await expect(rotated.unwrap(before.kekId, before.wrapped)).resolves.toHaveLength(32);
  });

  it("別の KEK・改ざんでは開けない", async () => {
    const p = new LocalKeyProvider({ v1: randomBytes(32) });
    const { kekId, wrapped } = await p.wrap(randomBytes(32));
    await expect(new LocalKeyProvider({ v1: randomBytes(32) }).unwrap(kekId, wrapped)).rejects.toThrow();
    wrapped[20]! ^= 1;
    await expect(p.unwrap(kekId, wrapped)).rejects.toThrow();
    await expect(p.unwrap("local:none", wrapped)).rejects.toThrow();
  });
});

describe("AzureKeyVaultKeyProvider", () => {
  it("鍵 ID の形式を検証する(接続はしない)", () => {
    expect(() => new AzureKeyVaultKeyProvider("https://example.vault.azure.net/keys/zairyu-kek", { getToken: async () => null })).not.toThrow();
    expect(() => new AzureKeyVaultKeyProvider("https://evil.example.com/keys/x", { getToken: async () => null })).toThrow();
  });
});

describe("BlobStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-blob-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const key = `${randomUUID()}/${randomUUID()}`;

  for (const [name, store] of [["memory", new MemoryBlobStore()], ["fs", new FsBlobStore(dir)]] as const) {
    it(`${name}: 保存・取得・削除`, async () => {
      await store.put(key, Buffer.from("abc"));
      expect((await store.get(key))?.toString()).toBe("abc");
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    });

    it(`${name}: テナントのファイルだけを一覧する(更新日時付き)`, async () => {
      const t1 = randomUUID();
      const t2 = randomUUID();
      await store.put(`${t1}/a`, Buffer.from("1"));
      await store.put(`${t1}/b`, Buffer.from("2"));
      await store.put(`${t2}/c`, Buffer.from("3"));
      const list = [];
      for await (const e of store.list(t1)) list.push(e);
      expect(list.map((e) => e.key).sort()).toEqual([`${t1}/a`, `${t1}/b`]);
      expect(list.every((e) => e.lastModified instanceof Date && e.lastModified.getTime() > 0)).toBe(true);
      const none = [];
      for await (const e of store.list(randomUUID())) none.push(e);
      expect(none).toEqual([]);
    });
  }

  it("一覧のテナント ID は形式を確かめる(パスを抜けさせない)", async () => {
    const store = new FsBlobStore(dir);
    await expect(async () => {
      for await (const _ of store.list("../x")) void _;
    }).rejects.toThrow();
  });

  it("パスを抜けるキーは拒否", () => {
    expect(() => assertBlobKey("../etc/passwd")).toThrow();
    expect(() => assertBlobKey(`${randomUUID()}/../../x`)).toThrow();
  });
});
