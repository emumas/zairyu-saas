/**
 * テナント別の鍵束。初回利用時にテナントの鍵を作り、KEK で包んで DB(tenant_keys)に保存する。
 * 開いた鍵はプロセス内に短時間だけキャッシュする(Key Vault への問い合わせを減らすため)。
 */
import { randomBytes } from "node:crypto";
import { schema, withTenant, type Db } from "@zairyu/db";
import { and, desc, eq } from "drizzle-orm";
import type { KeyProvider } from "./keyProvider.js";

type Purpose = "data" | "hmac";

export interface DataKey {
  version: number;
  key: Buffer;
}

export class TenantKeyring {
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();
  private readonly activeVersion = new Map<string, { version: number; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly provider: KeyProvider,
    private readonly options: { cacheTtlMs?: number; now?: () => number } = {},
  ) {}

  private get ttl() {
    return this.options.cacheTtlMs ?? 5 * 60_000;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** 新しく暗号化するときに使う鍵 */
  async activeDataKey(tenantId: string): Promise<DataKey> {
    return this.active(tenantId, "data");
  }

  /** 復号するときに使う鍵(暗号文に記録された版) */
  async dataKey(tenantId: string, version: number): Promise<Buffer> {
    return this.byVersion(tenantId, "data", version);
  }

  /** カード番号の検索列用の HMAC 鍵 */
  async hmacKey(tenantId: string): Promise<Buffer> {
    return (await this.active(tenantId, "hmac")).key;
  }

  /** データ鍵のローテーション。以後の暗号化は新しい版を使い、古い版は復号用に残る */
  async rotateDataKey(tenantId: string): Promise<number> {
    const version = await withTenant(this.db, tenantId, async (tx) => {
      const [latest] = await tx
        .select({ version: schema.tenantKeys.version })
        .from(schema.tenantKeys)
        .where(eq(schema.tenantKeys.purpose, "data"))
        .orderBy(desc(schema.tenantKeys.version))
        .limit(1);
      const next = (latest?.version ?? 0) + 1;
      await tx.update(schema.tenantKeys).set({ active: false }).where(and(eq(schema.tenantKeys.purpose, "data"), eq(schema.tenantKeys.active, true)));
      const { kekId, wrapped } = await this.provider.wrap(randomBytes(32));
      await tx.insert(schema.tenantKeys).values({ purpose: "data", version: next, wrappedKey: wrapped, kekId, active: true });
      return next;
    });
    this.activeVersion.delete(`${tenantId}:data`);
    return version;
  }

  private async active(tenantId: string, purpose: Purpose): Promise<DataKey> {
    const ak = `${tenantId}:${purpose}`;
    const cached = this.activeVersion.get(ak);
    if (cached && cached.expiresAt > this.now()) {
      return { version: cached.version, key: await this.byVersion(tenantId, purpose, cached.version) };
    }
    let row = await this.loadActive(tenantId, purpose);
    if (!row) row = await this.create(tenantId, purpose);
    const key = await this.provider.unwrap(row.kekId, row.wrappedKey);
    this.cache.set(`${ak}:${row.version}`, { key, expiresAt: this.now() + this.ttl });
    this.activeVersion.set(ak, { version: row.version, expiresAt: this.now() + this.ttl });
    return { version: row.version, key };
  }

  private async byVersion(tenantId: string, purpose: Purpose, version: number): Promise<Buffer> {
    const ck = `${tenantId}:${purpose}:${version}`;
    const cached = this.cache.get(ck);
    if (cached && cached.expiresAt > this.now()) return cached.key;
    const [row] = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantKeys)
        .where(and(eq(schema.tenantKeys.purpose, purpose), eq(schema.tenantKeys.version, version))),
    );
    if (!row) throw new Error("鍵が見つかりません");
    const key = await this.provider.unwrap(row.kekId, row.wrappedKey);
    this.cache.set(ck, { key, expiresAt: this.now() + this.ttl });
    return key;
  }

  private async loadActive(tenantId: string, purpose: Purpose) {
    const [row] = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantKeys)
        .where(and(eq(schema.tenantKeys.purpose, purpose), eq(schema.tenantKeys.active, true))),
    );
    return row ?? null;
  }

  /** 初回の鍵を作る。同時に作ろうとした場合は先に作られたほうを使う */
  private async create(tenantId: string, purpose: Purpose) {
    const { kekId, wrapped } = await this.provider.wrap(randomBytes(32));
    await withTenant(this.db, tenantId, (tx) =>
      tx.insert(schema.tenantKeys).values({ purpose, version: 1, wrappedKey: wrapped, kekId, active: true }).onConflictDoNothing(),
    );
    const row = await this.loadActive(tenantId, purpose);
    if (!row) throw new Error("鍵を作成できませんでした");
    return row;
  }
}
