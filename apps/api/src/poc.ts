/**
 * フェーズ0 PoC 用: 端末が読み出した IC の EF を受け取り、署名検証と解釈を行う。
 * - 個人情報を扱うため、入力・出力をログに出さないこと(CLAUDE.md ルール2)
 * - 保存はしない(PoC は検証結果を返すだけ)
 * - フェーズ1 で cards.submitIcRead(認証・テナント固定・保存・監査ログ)に置き換える
 */
import { describeFiles, parseCardRead, type EfPath } from "@zairyu/zairyu-ic";
import { verifyCardSignature } from "@zairyu/zairyu-ic/verify";
import { z } from "zod";
import { trustedIssuers } from "./trust.js";

const EF_PATHS = [
  "mf/ef01", "mf/ef02",
  "df1/ef01", "df1/ef02", "df1/ef03", "df1/ef04",
  "df2/ef01", "df2/ef02", "df2/ef03", "df2/ef04",
  "df3/ef01",
] as const satisfies readonly EfPath[];

/** 1 EF あたり最大 7004 バイト → base64 で 9340 文字程度 */
const base64 = z.string().max(12_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const verifyIcReadInput = z.object({
  format: z.enum(["legacy", "gen2", "tokutei"]),
  kind: z.enum(["residence", "special_permanent"]),
  files: z.partialRecord(z.enum(EF_PATHS), base64),
});

export const verifyIcReadOutput = z.object({
  signature: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("valid"),
      issuerTrusted: z.boolean().nullable(),
      certificateValidAt: z.boolean(),
      matched: z.string(),
      hashFormat: z.enum(["raw", "digestInfo"]).optional(),
    }),
    z.object({ status: z.literal("invalid"), reason: z.string(), detail: z.string().optional() }),
    z.object({ status: z.literal("absent") }),
  ]),
  cardNumber: z.string().nullable(),
  faceItems: z.record(z.string(), z.string().nullable()).nullable(),
  back: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
  images: z.object({ front: z.number(), face: z.number(), name: z.number(), address: z.number() }),
  /** 診断用: 各 EF の TLV 構造(タグと長さのみ) */
  structure: z.record(z.string(), z.string()),
});

export function verifyIcRead(input: z.infer<typeof verifyIcReadInput>): z.infer<typeof verifyIcReadOutput> {
  const files: Partial<Record<EfPath, Uint8Array>> = {};
  for (const [path, b64] of Object.entries(input.files)) files[path as EfPath] = Buffer.from(b64, "base64");
  const parsed = parseCardRead({ format: input.format, kind: input.kind, files });
  const { format: _format, ...back } = parsed.back;
  return {
    signature: verifyCardSignature(parsed.signature, { trustedIssuers: trustedIssuers() }),
    cardNumber: parsed.cardNumber,
    faceItems: parsed.faceItems ? { ...parsed.faceItems } : null,
    back,
    // 画像は PoC では返さない(形式が TIFF / JPEG2000 のため。サイズのみ)
    images: {
      front: parsed.images.front?.length ?? 0,
      face: parsed.images.face?.length ?? 0,
      name: parsed.images.name?.length ?? 0,
      address: parsed.images.address?.length ?? 0,
    },
    structure: describeFiles(files),
  };
}
