-- 運営者の操作記録は追記専用(運営者ロールにも UPDATE / DELETE を与えない)
GRANT SELECT, INSERT ON platform_audit_logs TO zairyu_platform;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE platform_audit_logs_id_seq TO zairyu_platform;
--> statement-breakpoint
REVOKE ALL ON platform_audit_logs FROM zairyu_app, zairyu_purge, zairyu_auth;
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_append_only BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_modify_append_only();
--> statement-breakpoint
CREATE TRIGGER platform_audit_logs_no_truncate BEFORE TRUNCATE ON platform_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify_append_only();
