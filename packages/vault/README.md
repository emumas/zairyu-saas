# @zairyu/vault

カード番号・画像のテナント別暗号化(1-4)。サーバー専用。

## 仕組み(エンベロープ暗号化)

| 鍵 | 置き場所 | 用途 |
| --- | --- | --- |
| KEK | Azure Key Vault(外に出ない)。開発は `VAULT_LOCAL_KEK` | テナント鍵の wrap / unwrap |
| テナントのデータ鍵(`tenant_keys.purpose = data`) | DB に KEK で包んで保存。版を持ちローテーション可 | 列・ファイルの AES-256-GCM |
| テナントの HMAC 鍵(`purpose = hmac`) | 同上。原則固定 | カード番号の検索列 |

- 暗号文の形式: `0x01 || 鍵の版(4) || iv(12) || tag(16) || 暗号文`。AAD に `テナントID|用途|版` を入れ、別テナント・別の列へ移した暗号文は復号できない
- 鍵はテナントの初回利用時に作る。開いた鍵はプロセス内で 5 分キャッシュ
- 画像は `<テナントID>/<UUID>` のキーで Blob に暗号文として置く。配信は API が復号して返す(`apps/api/src/images.ts`)。Blob の SAS URL は使わない

## 使い方

```ts
const vault = createVaultFromEnv(db);           // 環境変数は apps/api/.env.example 参照
const enc = await encryptCardNumber(vault.keyring, tenantId, "AB12345678CD");
const hmac = await cardNumberHmac(vault.keyring, tenantId, "AB12345678CD"); // 番号は正規化してから
const key = await putEncryptedBlob(vault.blobs, vault.keyring, tenantId, imageBytes);
```

## 運用

- データ鍵のローテーション: `keyring.rotateDataKey(tenantId)`。古い暗号文はそのまま読める(再暗号化は別ジョブ。`keyVersionOf` で判定)
- KEK のローテーション: Key Vault で新しい版を作る。`tenant_keys.kek_id` に版付きの鍵 ID が残るので古い版でも開ける
- HMAC 鍵を変える場合は検索列(`card_number_hmac`)の作り直しが必要
- Azure: App Service のマネージド ID に、Key Vault の鍵への `wrapKey` / `unwrapKey`(Key Vault Crypto User)と、Blob コンテナーへの読み書き(Storage Blob Data Contributor)を付与する
