-- 労働時間・長期休業期間(0001_security.sql と同じ方針)
ALTER TABLE work_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work_days FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON work_days FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON work_days TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON work_days FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON work_days TO zairyu_purge;
--> statement-breakpoint
ALTER TABLE study_breaks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE study_breaks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON study_breaks FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON study_breaks TO zairyu_app;
--> statement-breakpoint
CREATE POLICY purge_all ON study_breaks FOR ALL TO zairyu_purge USING (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON study_breaks TO zairyu_purge;
