-- 在籍期間の履歴(0001_security.sql と同じ方針)
ALTER TABLE person_employments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE person_employments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON person_employments FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON person_employments TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON person_employments FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON person_employments TO zairyu_purge;
