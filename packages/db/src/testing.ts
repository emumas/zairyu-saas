/**
 * テスト用: TEST_DATABASE_URL のサーバー上に用途別のデータベースを作り、スキーマを作り直してマイグレーションを流す。
 * パッケージごとに別 DB を使うので、テストを並行実行しても干渉しない。
 */
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

export async function prepareTestDatabase(baseUrl: string, name: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("DB 名が不正です");
  const u = new URL(baseUrl);
  const dbName = `${u.pathname.slice(1) || "postgres"}_${name}`;
  const admin = createDb(baseUrl, { max: 1 });
  try {
    const exists = await admin.db.execute(sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`);
    if (exists.rows.length === 0) await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
  } finally {
    await admin.pool.end();
  }
  u.pathname = `/${dbName}`;
  const target = createDb(u.toString(), { max: 1 });
  try {
    await target.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await target.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await target.db.execute(sql`CREATE SCHEMA public`);
  } finally {
    await target.pool.end();
  }
  await runMigrations(u.toString());
  return u.toString();
}
