import { describe, expect, it } from "vitest";
import { can, canAccessSite, MATRIX, PERMISSIONS, ROLES, siteScope, type Actor, type Permission, type Role } from "./permissions.js";

/** DESIGN.md 5章・8章から起こした期待値。変えるときは設計書も直すこと */
const EXPECTED: Record<Permission, Record<Role, boolean>> = {
  "dashboard.read": { tenant_admin: true, site_admin: true, viewer: true },
  "persons.read": { tenant_admin: true, site_admin: true, viewer: true },
  "persons.write": { tenant_admin: true, site_admin: true, viewer: false },
  "cards.write": { tenant_admin: true, site_admin: true, viewer: false },
  "cards.viewImage": { tenant_admin: true, site_admin: true, viewer: false },
  "verifications.read": { tenant_admin: true, site_admin: true, viewer: false },
  "verifications.write": { tenant_admin: true, site_admin: true, viewer: false },
  "alerts.read": { tenant_admin: true, site_admin: true, viewer: false },
  "alerts.ack": { tenant_admin: true, site_admin: true, viewer: false },
  "imports.run": { tenant_admin: true, site_admin: false, viewer: false },
  "org.manage": { tenant_admin: true, site_admin: false, viewer: false },
  "billing.manage": { tenant_admin: true, site_admin: false, viewer: false },
  "reports.export": { tenant_admin: true, site_admin: false, viewer: false },
  "tenant.settings": { tenant_admin: true, site_admin: false, viewer: false },
};

describe("権限マトリクス", () => {
  it("期待値の表がすべての権限を網羅している", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const perm of PERMISSIONS) {
    for (const role of ROLES) {
      it(`${role} は ${perm} を ${EXPECTED[perm][role] ? "持つ" : "持たない"}`, () => {
        expect(can(role, perm)).toBe(EXPECTED[perm][role]);
      });
    }
  }

  it("マトリクスに未定義の権限がない", () => {
    for (const role of ROLES) for (const p of MATRIX[role]) expect(PERMISSIONS).toContain(p);
  });
});

describe("拠点の範囲", () => {
  const base = { userId: "u", tenantId: "t", siteIds: ["s1", "s2"] };
  const admin: Actor = { ...base, role: "tenant_admin" };
  const siteAdmin: Actor = { ...base, role: "site_admin" };
  const viewer: Actor = { ...base, role: "viewer", siteIds: [] };

  it("テナント管理者は全拠点", () => {
    expect(siteScope(admin)).toBeNull();
    expect(canAccessSite(admin, "s9")).toBe(true);
  });

  it("拠点管理者は担当拠点のみ", () => {
    expect(siteScope(siteAdmin)).toEqual(["s1", "s2"]);
    expect(canAccessSite(siteAdmin, "s1")).toBe(true);
    expect(canAccessSite(siteAdmin, "s9")).toBe(false);
  });

  it("担当拠点のない閲覧者は何も見えない", () => {
    expect(siteScope(viewer)).toEqual([]);
    expect(canAccessSite(viewer, "s1")).toBe(false);
  });
});
