-- 監査ログの保存期間: テナント管理者が設定画面で変える
GRANT UPDATE (audit_retention_years) ON tenants TO zairyu_app;
--> statement-breakpoint
-- 保存期間が過ぎた運営者の操作記録を削除ジョブ(zairyu_purge)が消す。
-- 追記専用のトリガーは zairyu_purge の DELETE だけを通す。中身は読まない(日時と ID だけ)
GRANT SELECT (id, at), DELETE ON platform_audit_logs TO zairyu_purge;
