/**
 * KEK(鍵を暗号化する鍵)の提供元。テナントの鍵は KEK で包んで(wrap)DB に保存し、使うときに開く(unwrap)。
 * - AzureKeyVaultKeyProvider: 本番。KEK は Key Vault の外に出ない(RSA-OAEP-256 で wrap/unwrap を Key Vault に依頼)
 * - LocalKeyProvider: 開発・テスト用。環境変数の 32 バイト鍵で AES-256-GCM
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";

export interface KeyProvider {
  /** 新しく包むときに使う KEK の識別子 */
  readonly activeKekId: string;
  /** 包む。返り値の kekId を保存し、開くときに渡す */
  wrap(key: Buffer): Promise<{ kekId: string; wrapped: Buffer }>;
  unwrap(kekId: string, wrapped: Buffer): Promise<Buffer>;
}

export class LocalKeyProvider implements KeyProvider {
  private readonly keks: Map<string, Buffer>;

  /**
   * @param keks 識別子 → 32 バイト鍵。最初のものを新規の wrap に使う(KEK のローテーション時は古いものも残す)
   */
  constructor(keks: Record<string, Buffer>) {
    const entries = Object.entries(keks);
    if (entries.length === 0) throw new Error("KEK がありません");
    for (const [, k] of entries) if (k.length !== 32) throw new Error("KEK は 32 バイトです");
    this.keks = new Map(entries.map(([id, k]) => [`local:${id}`, k]));
    this.activeKekId = `local:${entries[0]![0]}`;
  }

  readonly activeKekId: string;

  async wrap(key: Buffer) {
    const kek = this.keks.get(this.activeKekId)!;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kek, iv);
    c.setAAD(Buffer.from(this.activeKekId));
    const ct = Buffer.concat([c.update(key), c.final()]);
    return { kekId: this.activeKekId, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]) };
  }

  async unwrap(kekId: string, wrapped: Buffer) {
    const kek = this.keks.get(kekId);
    if (!kek) throw new Error("KEK が見つかりません");
    const d = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12));
    d.setAAD(Buffer.from(kekId));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

export class AzureKeyVaultKeyProvider implements KeyProvider {
  private readonly clients = new Map<string, CryptographyClient>();

  /**
   * @param keyId Key Vault の鍵 ID(https://<vault>.vault.azure.net/keys/<name>)。版なしなら最新版で wrap する
   * @param credential 既定は DefaultAzureCredential(App Service のマネージド ID)
   */
  constructor(
    readonly activeKekId: string,
    private readonly credential: TokenCredential = new DefaultAzureCredential(),
  ) {
    if (!/^https:\/\/[^/]+\.vault\.azure\.net\/keys\/[^/]+(\/[^/]+)?$/.test(activeKekId)) {
      throw new Error("Key Vault の鍵 ID の形式が不正です");
    }
  }

  private client(keyId: string): CryptographyClient {
    let c = this.clients.get(keyId);
    if (!c) {
      c = new CryptographyClient(keyId, this.credential);
      this.clients.set(keyId, c);
    }
    return c;
  }

  async wrap(key: Buffer) {
    const r = await this.client(this.activeKekId).wrapKey("RSA-OAEP-256", key);
    // 版付きの鍵 ID を保存し、KEK の版が上がっても古い版で開けるようにする
    return { kekId: r.keyID ?? this.activeKekId, wrapped: Buffer.from(r.result) };
  }

  async unwrap(kekId: string, wrapped: Buffer) {
    const r = await this.client(kekId).unwrapKey("RSA-OAEP-256", wrapped);
    return Buffer.from(r.result);
  }
}
