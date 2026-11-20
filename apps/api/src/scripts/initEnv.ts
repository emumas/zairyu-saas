/**
 * 開発用の apps/api/.env を作る(鍵は乱数で生成)。既にあれば上書きしない。
 *   pnpm --filter api dev:init-env -- --database-url postgres://postgres:パスワード@localhost:5432/zairyu --public-url http://192.168.0.10:3000
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const path = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(path)) {
  // eslint-disable-next-line no-console -- 開発用スクリプトの案内
  console.log(`${path} は既にあります。作り直す場合は削除してから実行してください`);
  process.exit(0);
}
const databaseUrl = arg("database-url");
if (!databaseUrl) {
  // eslint-disable-next-line no-console -- 開発用スクリプトの案内
  console.error("--database-url を指定してください(例: postgres://postgres:パスワード@localhost:5432/zairyu)");
  process.exit(1);
}
const lines = [
  "PORT=3000",
  "ZAIRYU_ENABLE_POC=1",
  `DATABASE_URL=${databaseUrl}`,
  `AUTH_JWT_SECRET=${randomBytes(32).toString("hex")}`,
  `AUTH_SECRET_BOX_KEY=${randomBytes(32).toString("base64")}`,
  "VAULT_KEY_PROVIDER=local",
  `VAULT_LOCAL_KEK=${randomBytes(32).toString("base64")}`,
  "BLOB_STORE=fs",
  "BLOB_FS_DIR=./.blobs",
  `PUBLIC_BASE_URL=${arg("public-url") ?? "http://localhost:3000"}`,
  "",
];
writeFileSync(path, lines.join("\n"), { mode: 0o600 });
// eslint-disable-next-line no-console -- 開発用スクリプトの案内
console.log(`${path} を作成しました。鍵はこの PC 専用です。リポジトリにコミットしないでください`);
