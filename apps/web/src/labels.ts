/** 画面と出力で共通の表示名 */
export const METHOD_LABEL: Record<string, string> = { ic_signature: "IC 署名検証", ocr: "OCR", visual: "目視確認", revocation_check: "失効照会" };
export const RESULT_LABEL: Record<string, string> = { ok: "OK", mismatch: "差分あり", failed: "NG", revoked: "失効", unverifiable: "検証不可" };
export const FORMAT_LABEL = { legacy: "旧様式", gen2: "第2世代", tokutei: "特定在留カード" } as const;
