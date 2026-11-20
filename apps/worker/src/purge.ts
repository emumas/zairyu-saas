/**
 * 退職後データの自動削除(1-21)。毎日深夜(JST)に実行する。
 * テナントごとに、保存期間(3〜5 年)が過ぎた退職者のデータを消す。
 * 1. 行を消す(1 人ずつではなくまとめて、1 つのトランザクション)→ 2. 画像ファイルを消す → 3. 監査ログに残す
 * 行を先に消すので、ファイルの削除に失敗しても個人のデータに辿り着く手がかりは残らない(暗号化済みのファイルだけが残る)
 */
import { deletePersonsData, expiredPersons, insertAudit, tenantsForPurge, withPurge, withTenant, type Db } from "@zairyu/db";
import { jstDate } from "@zairyu/shared";
import type { BlobStore } from "@zairyu/vault";

export interface PurgeResult {
  tenantId: string;
  persons: number;
  cards: number;
  images: number;
  verifications: number;
  /** 消せなかった画像ファイル(次回以降の掃除で消す) */
  blobFailures: number;
}

export async function purgeExpired(db: Db, blobs: BlobStore | null, nowMs: number, opts: { dryRun?: boolean } = {}): Promise<PurgeResult[]> {
  const today = jstDate(nowMs);
  const results: PurgeResult[] = [];
  for (const t of await withPurge(db, (tx) => tenantsForPurge(tx))) {
    // 1 回 500 人ずつ。多いときは繰り返す
    for (;;) {
      const r = await withPurge(db, async (tx) => {
        const targets = await expiredPersons(tx, t.id, t.retentionYears, today);
        if (targets.length === 0 || opts.dryRun) return { targets, data: null };
        return { targets, data: await deletePersonsData(tx, t.id, targets.map((p) => p.id)) };
      });
      if (r.targets.length === 0) break;
      if (!r.data) {
        results.push({ tenantId: t.id, persons: r.targets.length, cards: 0, images: 0, verifications: 0, blobFailures: 0 });
        break;
      }
      if (r.data.blobKeys.length > 0 && !blobs) throw new Error("画像の保存先(BLOB_STORE)の設定がありません");
      let blobFailures = 0;
      for (const key of r.data.blobKeys) {
        try {
          await blobs!.delete(key);
        } catch {
          blobFailures++;
        }
      }
      await withTenant(db, t.id, async (tx) => {
        for (const p of r.targets) {
          await insertAudit(tx, { actorId: null, action: "person.purge", targetType: "person", targetId: p.id, detail: { retiredAt: p.retiredAt, retentionYears: t.retentionYears } });
        }
      });
      results.push({ tenantId: t.id, persons: r.targets.length, cards: r.data.cards, images: r.data.images, verifications: r.data.verifications, blobFailures });
    }
  }
  return results;
}
