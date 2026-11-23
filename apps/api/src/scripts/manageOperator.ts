/**
 * 運営者アカウントの一覧・停止・再開(1-19)。画面からは操作しない(運営者が自分たちを管理する経路を Web に作らない)。
 *   pnpm --filter api platform:operator -- --list
 *   pnpm --filter api platform:operator -- --disable --email ops@example.com
 *   pnpm --filter api platform:operator -- --enable --email ops@example.com
 * 停止した運営者は次のリクエストからログイン中のセッションも拒否される。再開するとロック(ログイン失敗の回数)も解除する。
 * 最後の 1 人は停止できない(誰も運営者コンソールに入れなくなるため)。操作は運営者の操作記録に残す
 */
import { createDb, schema, withPlatform } from "@zairyu/db";
import { and, eq, isNull, ne } from "drizzle-orm";

/* eslint-disable no-console -- 運用スクリプトの案内 */
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = process.env.DATABASE_URL;
const email = arg("email")?.trim().toLowerCase();
const mode = args.includes("--list") ? "list" : args.includes("--disable") ? "disable" : args.includes("--enable") ? "enable" : null;
if (!url || !mode || (mode !== "list" && !email)) {
  console.error("使い方: DATABASE_URL(apps/api/.env)を設定し、--list / --disable --email <メール> / --enable --email <メール>");
  process.exit(1);
}

const ops = schema.platformOperators;
const fmt = (d: Date | null) => (d ? d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "");
const { db, pool } = createDb(url, { max: 1 });
try {
  if (mode === "list") {
    const rows = await withPlatform(db, (tx) => tx.select().from(ops).orderBy(ops.email));
    if (rows.length === 0) console.log("運営者はいません");
    for (const r of rows) {
      const state = r.disabledAt ? `停止(${fmt(r.disabledAt)})` : r.lockedUntil && r.lockedUntil > new Date() ? `ロック中(${fmt(r.lockedUntil)} まで)` : "有効";
      console.log(`${r.email}\t${state}\t認証アプリ: ${r.totpSecretEnc ? "設定済み" : "未設定"}\t作成: ${fmt(r.createdAt)}`);
    }
  } else {
    const result = await withPlatform(db, async (tx) => {
      const [op] = await tx.select().from(ops).where(eq(ops.email, email!));
      if (!op) return `${email} の運営者はいません`;
      if (mode === "disable") {
        if (op.disabledAt) return `${email} は既に停止しています`;
        const others = await tx.select({ id: ops.id }).from(ops).where(and(ne(ops.id, op.id), isNull(ops.disabledAt)));
        if (others.length === 0) return "最後の 1 人の運営者は停止できません(先に別の運営者を作ってください)";
        await tx.update(ops).set({ disabledAt: new Date() }).where(eq(ops.id, op.id));
        await tx.insert(schema.platformAuditLogs).values({ operatorId: null, action: "operator.disable", targetType: "operator", targetId: op.id, detail: { via: "cli" } });
        return null;
      }
      if (!op.disabledAt && !op.lockedUntil && op.failedLoginCount === 0) return `${email} は既に有効です`;
      await tx.update(ops).set({ disabledAt: null, lockedUntil: null, failedLoginCount: 0 }).where(eq(ops.id, op.id));
      await tx.insert(schema.platformAuditLogs).values({ operatorId: null, action: "operator.enable", targetType: "operator", targetId: op.id, detail: { via: "cli" } });
      return null;
    });
    if (result) {
      console.error(result);
      process.exitCode = 1;
    } else {
      console.log(mode === "disable" ? `${email} を停止しました(ログイン中のセッションも次の操作から拒否されます)` : `${email} を再開しました(ロックも解除しました)`);
    }
  }
} finally {
  await pool.end();
}
