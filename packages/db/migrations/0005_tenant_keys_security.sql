-- テナント別の鍵: アプリは自テナントの鍵を参照・作成・切り替え(active)できる。削除はしない
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_keys FOR ALL TO zairyu_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON tenant_keys TO zairyu_app;
--> statement-breakpoint
GRANT UPDATE (active) ON tenant_keys TO zairyu_app;
