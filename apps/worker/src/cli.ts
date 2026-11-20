/**
 * 定期実行の入口(Azure の WebJobs / コンテナのスケジュール実行などから呼ぶ)
 *   daily: 期限アラートを作る(毎日 0:30 JST ごろ)→ 続けて送信
 *   send : 送信待ちの通知を送る(5 分おき)
 */
import { createDb } from "@zairyu/db";
import { activeTenantIds, generateAlerts, sendNotifications } from "./jobs.js";
import { notifierFromEnv } from "./notifiers.js";

/* eslint-disable no-console -- ジョブのログ(件数のみ。個人情報は出さない) */
const command = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url || (command !== "daily" && command !== "send")) {
  console.error("使い方: DATABASE_URL を設定して `cli.ts daily` または `cli.ts send`");
  process.exit(1);
}

const { db, pool } = createDb(url, { max: 2 });
const notifier = notifierFromEnv(process.env, (l) => console.log(l));
let failures = 0;
try {
  for (const tenantId of await activeTenantIds(db)) {
    try {
      if (command === "daily") {
        const r = await generateAlerts(db, tenantId, Date.now());
        console.log(`tenant=${tenantId} alerts_created=${r.created} recipients=${r.notified}`);
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
