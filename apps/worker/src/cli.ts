/**
 * 定期実行の入口(Azure の WebJobs / コンテナのスケジュール実行などから呼ぶ)
 *   daily: 前日の課金対象人数の記録と月次確定(1-16)、期限アラートを作る(毎日 0:30 JST ごろ)→ 続けて送信
 *   send : 送信待ちの通知を送る(5 分おき)
 *   purge: 保存期間が過ぎた退職者のデータを消し(1-21)、記録の無い画像ファイルと保存期間が過ぎた監査ログを掃除する(毎日 1:00 JST ごろ)。--dry-run で件数だけ表示
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@zairyu/db";
import { createVaultFromEnv } from "@zairyu/vault";
import { recordDailyBilling } from "./billing.js";
import { activeTenantIds, backfillNationalities, generateAlerts, generateNoticeAlerts, sendNotifications } from "./jobs.js";
import { notifierFromEnv } from "./notifiers.js";
import { purgeAuditLogs, purgeExpired, sweepOrphanBlobs } from "./purge.js";

/* eslint-disable no-console -- ジョブのログ(件数のみ。個人情報は出さない) */
const command = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url || (command !== "daily" && command !== "send" && command !== "purge")) {
  console.error("使い方: DATABASE_URL を設定して `cli.ts daily` / `cli.ts send` / `cli.ts purge [--dry-run]`");
  process.exit(1);
}

if (command === "purge") {
  // 開発用の BLOB_FS_DIR(相対パス)は API(apps/api)基準で書かれているので、そこから解決する
  const fsDir = process.env.BLOB_FS_DIR;
  if (fsDir && !isAbsolute(fsDir)) process.env.BLOB_FS_DIR = resolve(fileURLToPath(new URL("../../api", import.meta.url)), fsDir);
  const dryRun = process.argv.includes("--dry-run");
  const { db, pool } = createDb(url, { max: 2 });
  try {
    const blobs = process.env.BLOB_STORE ? createVaultFromEnv(db).blobs : null;
    const results = await purgeExpired(db, blobs, Date.now(), { dryRun });
    for (const r of results) {
      console.log(
        dryRun
          ? `tenant=${r.tenantId} purge_candidates=${r.persons} (dry-run)`
          : `tenant=${r.tenantId} purged_persons=${r.persons} cards=${r.cards} images=${r.images} verifications=${r.verifications} blob_failures=${r.blobFailures}`,
      );
    }
    if (results.length === 0) console.log("保存期間が過ぎた退職者はいません");
    // 削除ジョブで消せなかったファイルもここで拾う
    const swept = blobs ? await sweepOrphanBlobs(db, blobs, Date.now(), { dryRun }) : [];
    for (const s of swept) {
      console.log(dryRun ? `tenant=${s.tenantId} orphan_files=${s.orphans} (dry-run)` : `tenant=${s.tenantId} orphan_files=${s.orphans} deleted=${s.deleted} failures=${s.failures}`);
    }
    if (blobs && swept.length === 0) console.log("記録の無い画像ファイルはありません");
    // 保存期間が過ぎた監査ログ(テナントごとの設定)と運営者の操作記録(10 年)
    const audits = await purgeAuditLogs(db, Date.now(), { dryRun });
    for (const a of audits) {
      console.log(`${a.tenantId ? `tenant=${a.tenantId} audit_logs` : "platform_audit_logs"}_before=${a.before} ${dryRun ? "candidates" : "deleted"}=${a.deleted}${dryRun ? " (dry-run)" : ""}`);
    }
    if (audits.length === 0) console.log("保存期間が過ぎた監査ログはありません");
    process.exitCode = results.some((r) => r.blobFailures > 0) || swept.some((s) => s.failures > 0) ? 1 : 0;
  } catch (e) {
    console.error(`purge_error=${(e as Error).name}: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit();
}

const { db, pool } = createDb(url, { max: 2 });
const notifier = notifierFromEnv(process.env, (l) => console.log(l));
let failures = 0;
try {
  for (const tenantId of await activeTenantIds(db)) {
    try {
      if (command === "daily") {
        // 料金設定の誤りなどで失敗しても、期限アラートは止めない
        try {
          const b = await recordDailyBilling(db, tenantId, Date.now());
          console.log(`tenant=${tenantId} date=${b.date} active=${b.activeCount} period=${b.period} peak=${b.peakCount} amount=${b.amount ?? "no_plan"}${b.finalized ? " finalized" : ""}`);
        } catch (e) {
          failures++;
          console.error(`tenant=${tenantId} billing_error=${(e as Error).name}`);
        }
        const r = await generateAlerts(db, tenantId, Date.now());
        console.log(`tenant=${tenantId} alerts_created=${r.created} recipients=${r.notified}`);
        // 国籍が空欄の登録者にカードの国籍(国コード)を入れる
        try {
          const filled = await backfillNationalities(db, tenantId);
          if (filled > 0) console.log(`tenant=${tenantId} nationality_filled=${filled}`);
        } catch (e) {
          failures++;
          console.error(`tenant=${tenantId} nationality_error=${(e as Error).name}`);
        }
        // 外国人雇用状況の届出の期限(失敗しても期限アラート・送信は止めない)
        try {
          const n = await generateNoticeAlerts(db, tenantId, Date.now());
          if (n.created > 0) console.log(`tenant=${tenantId} notice_alerts_created=${n.created} recipients=${n.notified}`);
        } catch (e) {
          failures++;
          console.error(`tenant=${tenantId} notice_alert_error=${(e as Error).name}`);
        }
      }
      const s = await sendNotifications(db, tenantId, notifier, Date.now());
      if (s.sent + s.failed > 0) console.log(`tenant=${tenantId} sent=${s.sent} failed=${s.failed}`);
    } catch (e) {
      failures++;
      console.error(`tenant=${tenantId} error=${(e as Error).name}`);
    }
  }
} finally {
  await pool.end();
}
process.exit(failures > 0 ? 1 : 0);
