import type { Tx } from "../client.js";
import { auditLogs } from "../schema.js";

export interface AuditEntry {
  actorId: string | null;
  /** 例: person.create, person.update, card_image.view */
  action: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** 変更した項目名など。値(個人情報)は入れない */
  detail?: Record<string, unknown> | undefined;
  ip?: string | null | undefined;
}

export async function insertAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    detail: e.detail ?? null,
    ip: e.ip ?? null,
  });
}
