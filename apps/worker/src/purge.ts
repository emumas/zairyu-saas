/**
 * 退職後データの自動削除(1-21)。毎日深夜(JST)に実行する。
 * テナントごとに、保存期間(3〜5 年)が過ぎた退職者のデータを消す。
 * 1. 行を消す(1 人ずつではなくまとめて、1 つのトランザクション)→ 2. 画像ファイルを消す → 3. 監査ログに残す
 * 行を先に消すので、ファイルの削除に失敗しても個人のデータに辿り着く手がかりは残らない(暗号化済みのファイルだけが残る)
 */
import { deletePersonsData, expiredPersons, insertAudit, referencedBlobKeys, tenantsForPurge, withPurge, withTenant, type Db } from "@zairyu/db";
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

/** これより新しいファイルは消さない(カード登録の途中でファイルだけ先に保存されている場合があるため) */
export const ORPHAN_MIN_AGE_MS = 24 * 3600_000;

export interface SweepResult {
  tenantId: string;
  /** 記録の無いファイルの数(dry-run では消す予定の数) */
  orphans: number;
  deleted: number;
  failures: number;
}

/**
 * 孤立した画像ファイルの掃除: カード画像の記録が無いファイルを消す。
 * 原因は、カード登録の失敗(ファイルを保存した後に DB への保存が失敗)と、削除ジョブでのファイル削除の失敗。
 * 中身は暗号化済みだが、不要なデータを持ち続けないために消す
 */
export async function sweepOrphanBlobs(db: Db, blobs: BlobStore, nowMs: number, opts: { dryRun?: boolean; minAgeMs?: number } = {}): Promise<SweepResult[]> {
  const cutoff = nowMs - (opts.minAgeMs ?? ORPHAN_MIN_AGE_MS);
  const results: SweepResult[] = [];
  for (const t of await withPurge(db, (tx) => tenantsForPurge(tx))) {
    const r: SweepResult = { tenantId: t.id, orphans: 0, deleted: 0, failures: 0 };
    let batch: string[] = [];
    const flush = async () => {
      const known = await withPurge(db, (tx) => referencedBlobKeys(tx, t.id, batch));
      for (const key of batch.filter((k) => !known.has(k))) {
        r.orphans++;
        if (opts.dryRun) continue;
        try {
          await blobs.delete(key);
          r.deleted++;
        } catch {
          r.failures++;
        }
      }
      batch = [];
    };
    for await (const e of blobs.list(t.id)) {
      if (e.lastModified.getTime() > cutoff) continue;
      batch.push(e.key);
      if (batch.length >= 500) await flush();
    }
    if (batch.length > 0) await flush();
    if (r.orphans > 0) results.push(r);
  }
  return results;
}
