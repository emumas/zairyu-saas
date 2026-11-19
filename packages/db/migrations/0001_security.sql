-- テナント分離(RLS)・ロール別の権限・追記専用テーブルの保護。
-- drizzle-kit が生成しない部分なので手書きで管理する(packages/db/README.md 参照)。
--
-- ロール(NOLOGIN のグループロール。実際の接続ユーザーはこれらのメンバーにする)
--   zairyu_app      : API・ワーカー。app.tenant_id で指定したテナントの行だけ読み書きできる
--   zairyu_platform : 運営者コンソール。テナント・プラン・請求のみ。登録者の個人情報には触れない
--   zairyu_purge    : 保存期間切れデータの削除ジョブ。確認履歴・監査ログを削除できる唯一のロール
--   zairyu_auth     : ログイン時のユーザー検索関数の所有者(テナント確定前に users を引くため)

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zairyu_app') THEN CREATE ROLE zairyu_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zairyu_platform') THEN CREATE ROLE zairyu_platform NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zairyu_purge') THEN CREATE ROLE zairyu_purge NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zairyu_auth') THEN CREATE ROLE zairyu_auth NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO zairyu_app, zairyu_platform, zairyu_purge, zairyu_auth;
--> statement-breakpoint

-- 現在のテナント(未設定なら NULL → どの行にも一致しない)
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- ---------------------------------------------------------------- RLS(テナントに属するテーブル)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sites', 'users', 'user_sites', 'persons', 'residence_cards', 'card_images', 'verifications',
    'alerts', 'work_hours', 'daily_counts', 'billing_periods', 'audit_logs', 'tenant_price_overrides'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO zairyu_app '
      'USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants FOR ALL TO zairyu_app
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
--> statement-breakpoint
CREATE POLICY platform_all ON tenants FOR ALL TO zairyu_platform USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 運営者が触れるテーブル(個人情報を含まないもの)
CREATE POLICY platform_all ON tenant_price_overrides FOR ALL TO zairyu_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY platform_all ON billing_periods FOR ALL TO zairyu_platform USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY platform_read ON daily_counts FOR SELECT TO zairyu_platform USING (true);
--> statement-breakpoint
-- テナント開設時に最初の管理者を招待するため、users は INSERT と非機密列の参照のみ
CREATE POLICY platform_invite ON users FOR INSERT TO zairyu_platform WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY platform_read ON users FOR SELECT TO zairyu_platform USING (true);
--> statement-breakpoint

-- 削除ジョブ(テナント横断)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'persons', 'residence_cards', 'card_images', 'verifications', 'alerts', 'work_hours', 'audit_logs'
  ] LOOP
    EXECUTE format('CREATE POLICY purge_all ON %I FOR ALL TO zairyu_purge USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY purge_read ON tenants FOR SELECT TO zairyu_purge USING (true);
--> statement-breakpoint

-- ログイン時のユーザー検索
CREATE POLICY auth_lookup ON users FOR SELECT TO zairyu_auth USING (true);
--> statement-breakpoint

-- ---------------------------------------------------------------- 権限
-- zairyu_app: 登録者・カード・画像は物理削除しない(退職・アーカイブで扱い、削除は zairyu_purge)
GRANT SELECT, INSERT, UPDATE ON sites, users, persons, residence_cards, card_images, alerts,
  daily_counts, billing_periods TO zairyu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON user_sites TO zairyu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON work_hours TO zairyu_app;
--> statement-breakpoint
-- 追記専用
GRANT SELECT, INSERT ON verifications, audit_logs TO zairyu_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO zairyu_app;
--> statement-breakpoint
GRANT SELECT ON plans, tenant_price_overrides TO zairyu_app;
--> statement-breakpoint
-- 自テナントの設定のうち、テナント管理者が変えられる列だけ
GRANT SELECT ON tenants TO zairyu_app;
--> statement-breakpoint
GRANT UPDATE (name, retention_years, updated_at) ON tenants TO zairyu_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON tenants, plans, tenant_price_overrides, platform_operators TO zairyu_platform;
--> statement-breakpoint
GRANT SELECT, UPDATE ON billing_periods TO zairyu_platform;
--> statement-breakpoint
GRANT SELECT ON daily_counts TO zairyu_platform;
--> statement-breakpoint
GRANT INSERT (tenant_id, email, role, status) ON users TO zairyu_platform;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, email, role, status, created_at, last_login_at) ON users TO zairyu_platform;
--> statement-breakpoint

GRANT SELECT, DELETE ON persons, residence_cards, card_images, verifications, alerts, work_hours, audit_logs
  TO zairyu_purge;
--> statement-breakpoint
GRANT SELECT ON tenants TO zairyu_purge;
--> statement-breakpoint

GRANT SELECT ON users TO zairyu_auth;
--> statement-breakpoint

-- ログイン用: メールアドレスからユーザーを引く(テナント確定前のため RLS を越える唯一の経路)
CREATE FUNCTION auth_lookup_user(p_email text)
  RETURNS TABLE (id uuid, tenant_id uuid, password_hash text, role user_role, status user_status, totp_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.role, u.status, u.totp_enabled
    FROM users u WHERE lower(u.email) = lower(p_email)
  $$;
--> statement-breakpoint
ALTER FUNCTION auth_lookup_user(text) OWNER TO zairyu_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_lookup_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO zairyu_app;
--> statement-breakpoint

-- ---------------------------------------------------------------- 追記専用(確認履歴・監査ログ)
-- 権限に加え、トリガーでも UPDATE / DELETE / TRUNCATE を拒否する(所有者でも不可)。
-- 例外は保存期間切れの削除で、SET ROLE zairyu_purge したセッションの DELETE だけ通す。
CREATE FUNCTION forbid_modify_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'zairyu_purge' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% は追記専用です(%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER verifications_append_only BEFORE UPDATE OR DELETE ON verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_modify_append_only();
--> statement-breakpoint
CREATE TRIGGER verifications_no_truncate BEFORE TRUNCATE ON verifications
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_modify_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modify_append_only();
