-- 端末トークンと通知の送信待ち(0001_security.sql と同じ方針)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_devices', 'notification_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO zairyu_app '
      'USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY purge_all ON %I FOR ALL TO zairyu_purge USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON user_devices TO zairyu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON notification_outbox TO zairyu_app;
--> statement-breakpoint
GRANT SELECT, DELETE ON user_devices, notification_outbox TO zairyu_purge;
