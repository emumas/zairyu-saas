/**
 * 小さな秘密(TOTP 秘密鍵など)の暗号化。AES-256-GCM、関連データ(AAD)で行に結び付ける。
 * 形式: version(1)=0x01 || iv(12) || tag(16) || ciphertext
 * 1-4 でテナント別鍵(Key Vault)の実装に差し替えられるよう、インターフェースで扱う
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretBox {
  seal(plain: Uint8Array, aad: string): Buffer;
  open(sealed: Uint8Array, aad: string): Buffer;
}

export function createLocalSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("鍵は 32 バイトです");
  return {
    seal(plain, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([Buffer.of(1), iv, c.getAuthTag(), ct]);
    },
    open(sealed, aad) {
      const b = Buffer.from(sealed);
      if (b[0] !== 1 || b.length < 29) throw new Error("暗号文の形式が不正です");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 13));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([d.update(b.subarray(29)), d.final()]);
    },
  };
}
