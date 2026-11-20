/** 登録者 API の入出力(mobile / web / api で共有) */
import { z } from "zod";
import { EXPIRY_BUCKETS } from "./expiry.js";
import { isValidDate } from "./jst.js";

export const dateString = z.string().refine(isValidDate, "日付は YYYY-MM-DD で入力してください");

export const PERSON_STATUSES = ["active", "retired", "archived"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const personNameSchema = z.string().trim().min(1, "氏名を入力してください").max(200);
export const employeeCodeSchema = z
  .string()
  .trim()
  .min(1, "社員番号を入力してください")
  .max(50)
  .regex(/^[\x21-\x7E]+$/, "社員番号は半角英数記号で入力してください");
/** 国籍・地域(ISO 3166-1 alpha-3 相当の英大文字 3 文字) */
export const nationalitySchema = z.string().regex(/^[A-Z]{3}$/, "国籍は英大文字 3 文字(例: VNM)で入力してください");

export const personCreateInput = z.object({
  siteId: z.uuid(),
  employeeCode: employeeCodeSchema,
  name: personNameSchema,
  nationality: nationalitySchema.nullish(),
  birthDate: dateString.nullish(),
});
export type PersonCreateInput = z.infer<typeof personCreateInput>;

export const personUpdateInput = z.object({
  id: z.uuid(),
  siteId: z.uuid().optional(),
  employeeCode: employeeCodeSchema.optional(),
  name: personNameSchema.optional(),
  nationality: nationalitySchema.nullish(),
  birthDate: dateString.nullish(),
});
export type PersonUpdateInput = z.infer<typeof personUpdateInput>;

export const personListInput = z.object({
  /** 氏名の部分一致または社員番号の前方一致 */
  q: z.string().trim().max(100).optional(),
  siteId: z.uuid().optional(),
  /** 既定は在籍中と退職(アーカイブを除く)。期限区分・目印で絞り込むときの既定は在籍中のみ */
  statuses: z.array(z.enum(PERSON_STATUSES)).min(1).optional(),
  /** 期限区分(1-11)。指定した区分のいずれか */
  expiryBuckets: z.array(z.enum(EXPIRY_BUCKETS)).min(1).optional(),
  icUnverified: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  sort: z.enum(["employeeCode", "name", "expiryDate"]).default("employeeCode"),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});
export type PersonListInput = z.infer<typeof personListInput>;

// ---------------------------------------------------------------- 組織(1-15)

export const USER_ROLES = ["tenant_admin", "site_admin", "viewer"] as const;
export const USER_ROLE_LABEL: Record<(typeof USER_ROLES)[number], string> = {
  tenant_admin: "テナント管理者",
  site_admin: "拠点管理者",
  viewer: "閲覧者",
};

export const siteNameInput = z.string().trim().min(1, "拠点名を入力してください").max(100);

export const inviteUserInput = z.object({
  email: z.email("メールアドレスの形式が正しくありません").trim().toLowerCase().max(254),
  role: z.enum(USER_ROLES),
  /** 拠点管理者・閲覧者の担当拠点(テナント管理者は全拠点のため不要) */
  siteIds: z.array(z.uuid()).max(200).default([]),
});
