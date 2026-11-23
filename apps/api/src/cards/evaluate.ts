/**
 * IC の読み出し結果の評価(署名検証・項目の取り出し・券面との照合)。保存はしない。
 * 端末から届いた検証結果は使わず、必ずここでサーバーが検証する
 */
import { parseCardRead, parseTlv, type EfPath, type ParsedCard } from "@zairyu/zairyu-ic";
import { verifyCardSignature, type SignatureVerification } from "@zairyu/zairyu-ic/verify";
import type { CardManualFields, IcReadPayload } from "@zairyu/shared";
import { TRPCError } from "@trpc/server";
import type { X509Certificate } from "node:crypto";

/** residence_cards に入れる項目 */
export interface CardFields {
  statusOfResidence: string | null;
  periodOfStay: string | null;
  permissionType: string | null;
  permittedAt: string | null;
  expiryDate: string | null;
  cardValidUntil: string | null;
  workRestriction: string | null;
  outsideActivity: string | null;
  outsideActivityUntil: string | null;
  pendingApplication: boolean | null;
  /** カード記載の生年月日・性別(M / F)・国籍・地域 */
  birthDate: string | null;
  sex: string | null;
  nationality: string | null;
}

/** IC の性別の値を M / F にそろえる(仕様のコード値と文字の両方に備える) */
function normalizeSex(v: string | null): string | null {
  if (v === null) return null;
  if (v === "M" || v === "1") return "M";
  if (v === "F" || v === "2") return "F";
  return null;
}

const EMPTY: CardFields = {
  statusOfResidence: null,
  periodOfStay: null,
  permissionType: null,
  permittedAt: null,
  expiryDate: null,
  cardValidUntil: null,
  workRestriction: null,
  outsideActivity: null,
  outsideActivityUntil: null,
  pendingApplication: null,
  birthDate: null,
  sex: null,
  nationality: null,
};

export interface IcImage {
  kind: "ic_front" | "ic_face" | "ic_name" | "ic_address";
  contentType: string;
  data: Uint8Array;
}

export interface IcEvaluation {
  format: ParsedCard["format"];
  kind: ParsedCard["kind"];
  signature: SignatureVerification;
  /** IC から取り出せた項目(旧様式は更新申請中・資格外活動のみ) */
  fields: CardFields;
  /** IC に記録された番号(第2世代・特定のみ) */
  cardNumber: string | null;
  images: IcImage[];
  /** 裏面に追記された住居地(旧様式は IC に文字で記録される。無ければ null) */
  backAddress: { address: string; writtenAt: string | null } | null;
  /** 旧様式の住居地(裏面追記)のファイルの中身の形(タグと長さだけ。値は含めない)。実カードでの切り分け用 */
  backAddressDiag: string | null;
}

/** ファイルの TLV のタグと長さだけを文字にする(例: "D2:8 D3:6 D4:0")。値(住所など)は含めない */
function tlvShape(data: Uint8Array | undefined): string | null {
  if (!data) return null;
  try {
    const tags = parseTlv(data).map((t) => `${t.tag.toString(16).toUpperCase()}:${t.value.length}`);
    return `${data.length}B ${tags.join(" ") || "(タグなし)"}`;
  } catch {
    return `${data.length}B (解釈できない)`;
  }
}

/** issuers: 信頼する発行者証明書(config.trustedIssuers) */
export function evaluateIc(payload: IcReadPayload, issuers: readonly X509Certificate[]): IcEvaluation {
  const files: Partial<Record<EfPath, Uint8Array>> = {};
  for (const [path, b64] of Object.entries(payload.files)) files[path as EfPath] = Buffer.from(b64, "base64");
  let parsed: ParsedCard;
  try {
    parsed = parseCardRead({ format: payload.format, kind: payload.kind, files });
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "IC のデータを解釈できませんでした。読み取り直してください" });
  }
  const signature = verifyCardSignature(parsed.signature, { trustedIssuers: issuers });

  let fields: CardFields;
  if (parsed.back.format === "legacy") {
    fields = {
      ...EMPTY,
      outsideActivity: parsed.back.outsideActivityComprehensive ?? parsed.back.outsideActivityIndividual,
      pendingApplication: parsed.back.renewalApplying,
    };
  } else {
    const f = parsed.faceItems!;
    fields = {
      statusOfResidence: f.statusOfResidence,
      periodOfStay: f.periodOfStay,
      permissionType: f.permissionType,
      permittedAt: f.permittedAt,
      expiryDate: f.stayExpiry,
      cardValidUntil: f.cardValidUntil,
      workRestriction: f.workRestriction,
      outsideActivity: parsed.back.outsideActivityComprehensive,
      outsideActivityUntil: parsed.back.outsideActivityComprehensiveUntil,
      pendingApplication: parsed.back.renewalApplying,
      birthDate: f.birthDate,
      sex: normalizeSex(f.sex),
      nationality: f.nationality,
    };
  }

  const images: IcImage[] = [];
  if (parsed.images.front) images.push({ kind: "ic_front", contentType: "image/tiff", data: parsed.images.front });
  if (parsed.images.face) images.push({ kind: "ic_face", contentType: "image/jp2", data: parsed.images.face });
  if (parsed.images.name) images.push({ kind: "ic_name", contentType: "image/tiff", data: parsed.images.name });
  if (parsed.images.address) images.push({ kind: "ic_address", contentType: "image/tiff", data: parsed.images.address });

  const backAddress =
    parsed.back.format === "legacy" && parsed.back.address?.trim() ? { address: parsed.back.address.trim(), writtenAt: parsed.back.addressWrittenAt } : null;
  const backAddressDiag = parsed.back.format === "legacy" ? tlvShape(files["df2/ef01"]) : null;
  return { format: parsed.format, kind: parsed.kind, signature, fields, cardNumber: parsed.cardNumber, images, backAddress, backAddressDiag };
}

export interface FieldDiff {
  field: "cardNumber" | "expiryDate" | "cardValidUntil" | "statusOfResidence" | "workRestriction" | "pendingApplication" | "birthDate";
  /** カード番号の差分は値を返さない(個人情報) */
  ic: string | boolean | null;
  input: string | boolean | null;
}

/** IC と入力(券面の OCR・目視)の食い違い。両方に値がある項目だけを比べる */
export function diffFields(ic: IcEvaluation | null, inputCardNumber: string, manual: CardManualFields): FieldDiff[] {
  if (!ic) return [];
  const diffs: FieldDiff[] = [];
  if (ic.cardNumber !== null && ic.cardNumber !== inputCardNumber) diffs.push({ field: "cardNumber", ic: null, input: null });
  const keys = ["expiryDate", "cardValidUntil", "statusOfResidence", "workRestriction", "pendingApplication", "birthDate"] as const;
  for (const k of keys) {
    const a = ic.fields[k];
    const b = manual[k];
    if (a !== null && a !== undefined && b !== null && b !== undefined && a !== b) diffs.push({ field: k, ic: a, input: b });
  }
  return diffs;
}

/** 保存する値: IC の値を優先し、無い項目は入力で補う */
export function mergeFields(ic: IcEvaluation | null, manual: CardManualFields): CardFields {
  const base = ic?.fields ?? EMPTY;
  return {
    ...base,
    expiryDate: base.expiryDate ?? manual.expiryDate ?? null,
    cardValidUntil: base.cardValidUntil ?? manual.cardValidUntil ?? null,
    statusOfResidence: base.statusOfResidence ?? manual.statusOfResidence ?? null,
    workRestriction: base.workRestriction ?? manual.workRestriction ?? null,
    pendingApplication: base.pendingApplication ?? manual.pendingApplication ?? null,
    birthDate: base.birthDate ?? manual.birthDate ?? null,
    sex: base.sex ?? manual.sex ?? null,
    nationality: base.nationality ?? manual.nationality ?? null,
  };
}

/** 署名の検証結果から、カードの状態と確認履歴の結果を決める */
export function judgeSignature(s: SignatureVerification): {
  icVerified: boolean;
  needsReview: boolean;
  result: "ok" | "failed" | "unverifiable";
} {
  if (s.status === "absent") return { icVerified: false, needsReview: false, result: "unverifiable" };
  if (s.status === "invalid") return { icVerified: false, needsReview: true, result: "failed" };
  // 同じ鍵種別の発行者証明書が無い間(issuerTrusted = null。第2世代の ECDSA)は署名の一致だけで検証済みとする
  if (s.issuerTrusted === false) return { icVerified: false, needsReview: true, result: "failed" };
  return { icVerified: true, needsReview: false, result: "ok" };
}
