-- リフレッシュトークンのテナント分離と権限(0001_security.sql と同じ方針)
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON refresh_tokens FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO zairyu_app;
--> statement-breakpoint
-- 運営者には新しい列も見せない(SELECT は列単位で付与済み)
CREATE POLICY purge_all ON refresh_tokens FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON refresh_tokens TO zairyu_purge;
