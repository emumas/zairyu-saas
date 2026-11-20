/** 登録者 API の入出力(mobile / web / api で共有) */
import { z } from "zod";
import { isValidDate } from "./jst.js";

export const dateString = z.string().refine(isValidDate, "日付は YYYY-MM-DD で入力してください");

export const PERSON_STATUSES = ["active", "retired", "archived"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

const name = z.string().trim().min(1, "氏名を入力してください").max(200);
const employeeCode = z
  .string()
  .trim()
  .min(1, "社員番号を入力してください")
  .max(50)
  .regex(/^[\x21-\x7E]+$/, "社員番号は半角英数記号で入力してください");
/** 国籍・地域(ISO 3166-1 alpha-3 相当の英大文字 3 文字) */
const nationality = z.string().regex(/^[A-Z]{3}$/, "国籍は英大文字 3 文字(例: VNM)で入力してください");

export const personCreateInput = z.object({
  siteId: z.uuid(),
  employeeCode,
  name,
  nationality: nationality.nullish(),
  birthDate: dateString.nullish(),
});
export type PersonCreateInput = z.infer<typeof personCreateInput>;

export const personUpdateInput = z.object({
  id: z.uuid(),
  siteId: z.uuid().optional(),
  employeeCode: employeeCode.optional(),
  name: name.optional(),
  nationality: nationality.nullish(),
  birthDate: dateString.nullish(),
});
export type PersonUpdateInput = z.infer<typeof personUpdateInput>;

export const personListInput = z.object({
  /** 氏名の部分一致または社員番号の前方一致 */
  q: z.string().trim().max(100).optional(),
  siteId: z.uuid().optional(),
  /** 既定は在籍中と退職(アーカイブを除く) */
  statuses: z.array(z.enum(PERSON_STATUSES)).min(1).optional(),
  sort: z.enum(["employeeCode", "name", "expiryDate"]).default("employeeCode"),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});
export type PersonListInput = z.infer<typeof personListInput>;
