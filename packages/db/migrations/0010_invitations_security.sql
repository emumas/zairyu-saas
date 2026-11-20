-- 招待(0001_security.sql と同じ方針)
ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_invitations FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON user_invitations TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON user_invitations FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON user_invitations TO zairyu_purge;
