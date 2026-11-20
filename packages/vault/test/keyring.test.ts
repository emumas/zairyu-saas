/** 実際の PostgreSQL で鍵束と列暗号化を確かめる(TEST_DATABASE_URL が無ければスキップ) */
import { randomBytes } from "node:crypto";
import { createDb, schema, withPlatform, withTenant, type Db } from "@zairyu/db";
import { prepareTestDatabase } from "@zairyu/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/blobStore.js";
import { getDecryptedBlob, putEncryptedBlob } from "../src/encryptedBlobs.js";
import { cardNumberHmac, decryptCardNumber, decryptField, encryptCardNumber, encryptField, keyVersionOf } from "../src/fieldCipher.js";
import { LocalKeyProvider } from "../src/keyProvider.js";
import { TenantKeyring } from "../src/keyring.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("テナント別の鍵と暗号化", () => {
  let db: Db;
  let end: () => Promise<void>;
  let keyring: TenantKeyring;
  let provider: LocalKeyProvider;
  let a: string;
  let b: string;

  beforeAll(async () => {
    const c = createDb(await prepareTestDatabase(url!, "vault"), { max: 4 });
    db = c.db;
    end = () => c.pool.end();
    provider = new LocalKeyProvider({ v1: randomBytes(32) });
    keyring = new TenantKeyring(db, provider);
    [a, b] = await withPlatform(db, async (tx) =>
      (await tx.insert(schema.tenants).values([{ name: "A" }, { name: "B" }]).returning()).map((r) => r.id) as [string, string],
    );
  });
  afterAll(async () => end?.());

  it("カード番号を暗号化・復号でき、DB の鍵は包まれた状態で保存される", async () => {
    const sealed = await encryptCardNumber(keyring, a, "AB12345678CD");
    expect(sealed.includes(Buffer.from("AB12345678CD"))).toBe(false);
    expect(await decryptCardNumber(keyring, a, sealed)).toBe("AB12345678CD");
    const keys = await withTenant(db, a, (tx) => tx.select().from(schema.tenantKeys));
    expect(keys.map((k) => k.purpose)).toEqual(["data"]);
    expect(keys[0]!.kekId).toBe("local:v1");
  });

  it("別テナント・別の用途の暗号文は復号できない", async () => {
    const sealed = await encryptCardNumber(keyring, a, "AB12345678CD");
    await expect(decryptCardNumber(keyring, b, sealed)).rejects.toThrow();
    await expect(decryptField(keyring, a, sealed, "other.column")).rejects.toThrow();
  });

  it("HMAC は同じ番号で一致し、テナントが違えば一致しない", async () => {
    const h1 = await cardNumberHmac(keyring, a, "AB12345678CD");
    const h2 = await cardNumberHmac(keyring, a, "AB12345678CD");
    const hb = await cardNumberHmac(keyring, b, "AB12345678CD");
    expect(h1.equals(h2)).toBe(true);
    expect(h1.equals(hb)).toBe(false);
    expect(h1.equals(await cardNumberHmac(keyring, a, "AB12345678CE"))).toBe(false);
  });

  it("キャッシュが切れても(別プロセスでも)同じ鍵で復号できる", async () => {
    const sealed = await encryptField(keyring, a, Buffer.from("x"), "t");
    const fresh = new TenantKeyring(db, provider);
    expect((await decryptField(fresh, a, sealed, "t")).toString()).toBe("x");
    expect((await cardNumberHmac(fresh, a, "N")).equals(await cardNumberHmac(keyring, a, "N"))).toBe(true);
  });

  it("データ鍵をローテーションしても古い暗号文を復号でき、新しい暗号文は新しい版になる", async () => {
    const before = await encryptField(keyring, a, Buffer.from("old"), "t");
    const hmacBefore = await cardNumberHmac(keyring, a, "N");
    const v = await keyring.rotateDataKey(a);
    const after = await encryptField(keyring, a, Buffer.from("new"), "t");
    expect(keyVersionOf(after)).toBe(v);
    expect(keyVersionOf(before)).toBe(v - 1);
    expect((await decryptField(keyring, a, before, "t")).toString()).toBe("old");
    expect((await decryptField(keyring, a, after, "t")).toString()).toBe("new");
    // HMAC 鍵はデータ鍵のローテーションで変わらない
    expect((await cardNumberHmac(keyring, a, "N")).equals(hmacBefore)).toBe(true);
  });

  it("同時に初回の鍵を作っても 1 つにそろう", async () => {
    const [c] = await withPlatform(db, async (tx) => tx.insert(schema.tenants).values({ name: "C" }).returning());
    const rings = Array.from({ length: 5 }, () => new TenantKeyring(db, provider));
    const sealed = await Promise.all(rings.map((r) => encryptField(r, c!.id, Buffer.from("x"), "t")));
    for (const s of sealed) expect((await decryptField(keyring, c!.id, s, "t")).toString()).toBe("x");
    const keys = await withTenant(db, c!.id, (tx) => tx.select().from(schema.tenantKeys));
    expect(keys).toHaveLength(1);
  });

  it("画像を暗号化して保存し、取り出せる。Blob 上は暗号文", async () => {
    const store = new MemoryBlobStore();
    const image = randomBytes(5000);
    const key = await putEncryptedBlob(store, keyring, a, image);
    expect(key.startsWith(`${a}/`)).toBe(true);
    expect(store.data.get(key)!.includes(image.subarray(0, 64))).toBe(false);
    expect((await getDecryptedBlob(store, keyring, a, key))?.equals(image)).toBe(true);
    // 別テナントからは読めない
    expect(await getDecryptedBlob(store, keyring, b, key)).toBeNull();
  });
});
