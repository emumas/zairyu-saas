-- パスワード再設定のリンク(0010_invitations_security.sql と同じ方針)
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON password_resets FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON password_resets TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON password_resets FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON password_resets TO zairyu_purge;
