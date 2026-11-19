/**
 * 権限マトリクス(DESIGN.md 5章・8章)。
 * すべての手続きは requirePermission で権限を宣言し、拠点を扱うものは assertSiteAccess / siteScope で範囲を絞る。
 * 運営者(platform)はテナントのユーザーとは別系統(1-19)で、ここには含めない。
 */

export const ROLES = ["tenant_admin", "site_admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard.read", // 期限区分の件数と一覧
  "persons.read", // 登録者の一覧・詳細(カード画像は含まない)
  "persons.write", // 登録・更新・退職・アーカイブ
  "cards.write", // カード登録・IC 再検証・画像アップロード
  "cards.viewImage", // カード画像の閲覧(監査ログに記録)
  "verifications.read",
  "verifications.write", // 失効照会・目視確認の記録
  "alerts.read",
  "alerts.ack",
  "imports.run", // CSV 一括取込
  "org.manage", // 拠点・ユーザー・権限
  "billing.manage", // 契約・請求
  "reports.export", // 確認履歴・監査ログの出力
  "tenant.settings", // 保存期間などテナント設定
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const SITE_STAFF: readonly Permission[] = [
  "dashboard.read",
  "persons.read",
  "persons.write",
  "cards.write",
  "cards.viewImage",
  "verifications.read",
  "verifications.write",
  "alerts.read",
  "alerts.ack",
];

export const MATRIX: Readonly<Record<Role, readonly Permission[]>> = {
  tenant_admin: PERMISSIONS,
  site_admin: SITE_STAFF,
  /** 期限と就労可否の閲覧のみ。カード画像は見ない */
  viewer: ["dashboard.read", "persons.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

/** テナント全体を見られるか(テナント管理者のみ) */
export function hasAllSites(role: Role): boolean {
  return role === "tenant_admin";
}

export interface Actor {
  userId: string;
  tenantId: string;
  role: Role;
  /** 担当拠点(tenant_admin は使わない) */
  siteIds: readonly string[];
}

/** 一覧取得などで使う拠点の範囲。null は全拠点 */
export function siteScope(actor: Actor): readonly string[] | null {
  return hasAllSites(actor.role) ? null : actor.siteIds;
}

export function canAccessSite(actor: Actor, siteId: string): boolean {
  return hasAllSites(actor.role) || actor.siteIds.includes(siteId);
}
