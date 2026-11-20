/**
 * 開発用: マイグレーションを流し、テナント・拠点・管理者ユーザーを作る(既にあれば作らない)。
 *   pnpm --filter api dev:setup -- --email you@example.com --password '12文字以上のパスワード'
 * 管理者は初回ログインで TOTP(認証アプリ)の設定を求められる
 */
import { createDb, runMigrations, schema, withPlatform, withTenant } from "@zairyu/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";

/* eslint-disable no-console -- 開発用スクリプトの案内 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = process.env.DATABASE_URL;
const email = arg("email")?.toLowerCase();
const password = arg("password");
if (!url || !email || !password) {
  console.error("DATABASE_URL(apps/api/.env)と --email / --password を指定してください");
  process.exit(1);
}

await runMigrations(url);
console.log("マイグレーションを適用しました");

const { db, pool } = createDb(url, { max: 1 });
try {
  const TENANT = "開発用テナント";
  let tenantId = await withPlatform(db, async (tx) => (await tx.select().from(schema.tenants).where(eq(schema.tenants.name, TENANT)))[0]?.id);
  if (!tenantId) {
    tenantId = await withPlatform(db, async (tx) => (await tx.insert(schema.tenants).values({ name: TENANT, status: "active" }).returning())[0]!.id);
    console.log(`テナント「${TENANT}」を作成しました`);
  }
  await withTenant(db, tenantId, async (tx) => {
    const sites = await tx.select().from(schema.sites);
    if (sites.length === 0) {
      await tx.insert(schema.sites).values({ name: "本社" });
      console.log("拠点「本社」を作成しました");
    }
    const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing) {
      console.log(`${email} は既にあります(パスワードは変更しません)`);
      return;
    }
    await tx.insert(schema.users).values({ email, role: "tenant_admin", status: "active", passwordHash: await hashPassword(password) });
    console.log(`テナント管理者 ${email} を作成しました。初回ログインで認証アプリ(TOTP)の設定を求められます`);
  });
} finally {
  await pool.end();
}
