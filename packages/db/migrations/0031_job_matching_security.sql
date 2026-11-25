-- 職種照合(テスト運用)(0001_security.sql と同じ方針)
ALTER TABLE job_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_categories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_categories FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON job_categories TO zairyu_app;
--> statement-breakpoint
ALTER TABLE job_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_checks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_checks FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
-- 確認の記録は追加だけ(変更・削除しない)
GRANT SELECT, INSERT ON job_checks TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON job_checks FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON job_checks TO zairyu_purge;
--> statement-breakpoint
GRANT UPDATE (job_matching_enabled) ON tenants TO zairyu_app;
