/**
 * 運営者アカウントを作る(1-19)。画面からは作れない。TOTP はここで設定する。
 *   pnpm --filter api platform:create-operator -- --email ops@example.com --password '12文字以上のパスワード'
 * 表示されたキー(または otpauth の URI)を認証アプリに登録すること。キーは二度と表示しない
 */
import { createDb, schema, withPlatform } from "@zairyu/db";
import { eq } from "drizzle-orm";
import { operatorTotpAad } from "../auth/platformAuth.js";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../auth/password.js";
import { createLocalSecretBox } from "../auth/secretBox.js";
import { base32Encode, generateTotpSecret, otpauthUri } from "../auth/totp.js";

/* eslint-disable no-console -- 運用スクリプトの案内 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
const boxKey = process.env.AUTH_SECRET_BOX_KEY;
const email = arg("email")?.trim().toLowerCase();
const password = arg("password");
if (!url || !boxKey || !email || !password) {
  console.error("DATABASE_URL と AUTH_SECRET_BOX_KEY(apps/api/.env)、--email / --password を指定してください");
  process.exit(1);
}
if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  console.error(`パスワードは ${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH} 文字にしてください`);
  process.exit(1);
}

const { db, pool } = createDb(url, { max: 1 });
try {
  const box = createLocalSecretBox(Buffer.from(boxKey, "base64"));
  const secret = generateTotpSecret();
  const created = await withPlatform(db, async (tx) => {
    const [existing] = await tx.select().from(schema.platformOperators).where(eq(schema.platformOperators.email, email));
    if (existing) return false;
    const [op] = await tx.insert(schema.platformOperators).values({ email, passwordHash: await hashPassword(password) }).returning();
    await tx.update(schema.platformOperators).set({ totpSecretEnc: box.seal(secret, operatorTotpAad(op!.id)) }).where(eq(schema.platformOperators.id, op!.id));
    await tx.insert(schema.platformAuditLogs).values({ operatorId: op!.id, action: "operator.create" });
    return true;
  });
  if (!created) {
    console.error(`${email} は既にあります`);
    process.exitCode = 1;
  } else {
    console.log(`運営者 ${email} を作成しました。認証アプリに次のキーを登録してください(この画面にだけ表示します)`);
    console.log(`キー: ${base32Encode(secret)}`);
    console.log(`URI: ${otpauthUri(secret, email, process.env.AUTH_TOTP_ISSUER ?? "在留カード管理(運営)")}`);
  }
} finally {
  await pool.end();
}
