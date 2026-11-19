/**
 * DB 接続とトランザクションの入口。
 * テナントのデータには必ず withTenant 経由でアクセスする(RLS のセッション変数とロールを設定する)。
 */
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(connectionString: string, options: { max?: number } = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return { db: drizzle(pool, { schema }), pool };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * テナントを固定したトランザクション。
 * tenantId は認証済みセッションから得た値だけを渡すこと(クライアント入力を渡さない)。
 * 接続ユーザーは zairyu_app のメンバーである必要がある。
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("テナント ID が不正です");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE zairyu_app`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** 運営者コンソール用(テナント横断。個人情報のテーブルには権限がない) */
export async function withPlatform<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE zairyu_platform`);
    return fn(tx);
  });
}

/** 保存期間切れデータの削除ジョブ用 */
export async function withPurge<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE zairyu_purge`);
    return fn(tx);
  });
}

export type AuthUserRow = {
  id: string;
  tenant_id: string;
  password_hash: string | null;
  role: "tenant_admin" | "site_admin" | "viewer";
  status: "invited" | "active" | "suspended";
  totp_enabled: boolean;
};

/** ログイン用: メールアドレスでユーザーを引く(テナント確定前に使う唯一の横断検索) */
export async function lookupUserForLogin(db: Db, email: string): Promise<AuthUserRow | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE zairyu_app`);
    const res = await tx.execute<AuthUserRow>(sql`SELECT * FROM auth_lookup_user(${email})`);
    return (res.rows[0] as AuthUserRow | undefined) ?? null;
  });
}
