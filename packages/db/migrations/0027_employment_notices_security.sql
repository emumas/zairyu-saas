-- 外国人雇用状況の届出の提出記録(0001_security.sql と同じ方針)
ALTER TABLE employment_notices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE employment_notices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON employment_notices FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_notices TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON employment_notices FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON employment_notices TO zairyu_purge;
--> statement-breakpoint
-- 事業主の情報はテナント管理者が設定画面で変える(届出の管理を始める日は運営者だけが変える)
GRANT UPDATE (employer_name, employer_address, employer_phone, representative_name) ON tenants TO zairyu_app;
