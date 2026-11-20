/**
 * 失効情報照会(1-9、半自動)。
 * 入管庁の照会ページを開き、管理者が照会して結果を記録する。ページへの機械的なアクセス(スクレイピング)はしない(CLAUDE.md ルール6)
 */
import { z } from "zod";

/** 在留カード等番号失効情報照会(入管庁)。海外の IP からは使えない。交付当日の分は翌日以降に反映 */
export const REVOCATION_CHECK_URL = "https://lapse-immi.moj.go.jp/html/top.html";

export const REVOCATION_RESULTS = ["valid", "revoked", "not_found"] as const;
export type RevocationResult = (typeof REVOCATION_RESULTS)[number];

export const REVOCATION_RESULT_LABEL: Record<RevocationResult, string> = {
  valid: "有効(失効していない)",
  revoked: "失効している",
  not_found: "照会結果が出ない(交付当日のカードなど)",
};

export const recordRevocationCheckInput = z.object({
  cardId: z.uuid(),
  result: z.enum(REVOCATION_RESULTS),
  note: z.string().trim().max(500).optional(),
  deviceId: z.string().max(100).optional(),
});
