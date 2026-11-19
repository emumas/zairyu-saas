CREATE TYPE "public"."alert_type" AS ENUM('expiry_90', 'expiry_60', 'expiry_30', 'expired', 'recheck_revocation', 'hours_limit');--> statement-breakpoint
CREATE TYPE "public"."billing_mode" AS ENUM('per_unit', 'tiered');--> statement-breakpoint
CREATE TYPE "public"."billing_period_status" AS ENUM('open', 'finalized', 'reported', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."card_format" AS ENUM('legacy', 'gen2', 'tokutei');--> statement-breakpoint
CREATE TYPE "public"."card_image_kind" AS ENUM('front', 'back', 'ic_face', 'ic_front', 'ic_name', 'ic_address');--> statement-breakpoint
CREATE TYPE "public"."card_kind" AS ENUM('residence', 'special_permanent');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('active', 'retired', 'archived');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('trial', 'active', 'past_due', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('tenant_admin', 'site_admin', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('ic_signature', 'ocr', 'visual', 'revocation_check');--> statement-breakpoint
CREATE TYPE "public"."verification_result" AS ENUM('ok', 'mismatch', 'failed', 'revoked', 'unverifiable');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"card_id" uuid,
	"type" "alert_type" NOT NULL,
	"due_date" date NOT NULL,
	"sent_at" timestamp with time zone,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"period" text NOT NULL,
	"peak_count" integer NOT NULL,
	"amount" integer NOT NULL,
	"stripe_invoice_id" text,
	"status" "billing_period_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_period_ck" CHECK ("billing_periods"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "billing_periods_amounts_ck" CHECK ("billing_periods"."peak_count" >= 0 and "billing_periods"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "card_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" "card_image_kind" NOT NULL,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_counts" (
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"date" date NOT NULL,
	"active_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_counts_tenant_id_date_pk" PRIMARY KEY("tenant_id","date")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"employee_code" text NOT NULL,
	"name" text NOT NULL,
	"nationality" text,
	"birth_date" date,
	"status" "person_status" DEFAULT 'active' NOT NULL,
	"retired_at" date,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_fee" integer DEFAULT 0 NOT NULL,
	"billing_mode" "billing_mode" NOT NULL,
	"unit_price" integer,
	"tiers_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_amounts_ck" CHECK ("plans"."base_fee" >= 0 and coalesce("plans"."unit_price", 0) >= 0),
	CONSTRAINT "plans_mode_ck" CHECK (("plans"."billing_mode" = 'per_unit' and "plans"."unit_price" is not null) or ("plans"."billing_mode" = 'tiered' and "plans"."tiers_json" is not null))
);
--> statement-breakpoint
CREATE TABLE "platform_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_operators_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "residence_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"card_format" "card_format" NOT NULL,
	"card_kind" "card_kind" DEFAULT 'residence' NOT NULL,
	"card_number_enc" "bytea" NOT NULL,
	"card_number_hmac" "bytea" NOT NULL,
	"status_of_residence" text,
	"period_of_stay" text,
	"permission_type" text,
	"permitted_at" date,
	"expiry_date" date,
	"card_valid_until" date,
	"work_restriction" text,
	"outside_activity" text,
	"outside_activity_until" date,
	"pending_application" boolean DEFAULT false NOT NULL,
	"pending_application_since" date,
	"ic_verified" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"issued_at" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"plan_id" uuid,
	"base_fee" integer,
	"unit_price" integer,
	"tiers_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_price_overrides_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'trial' NOT NULL,
	"stripe_customer_id" text,
	"plan_id" uuid,
	"retention_years" integer DEFAULT 5 NOT NULL,
	"past_due_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_retention_years_ck" CHECK ("tenants"."retention_years" between 3 and 5)
);
--> statement-breakpoint
CREATE TABLE "user_sites" (
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "user_sites_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"totp_secret_enc" "bytea",
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"method" "verification_method" NOT NULL,
	"result" "verification_result" NOT NULL,
	"diff_json" jsonb,
	"note" text,
	"performed_by" uuid NOT NULL,
	"device_id" text,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_hours" (
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "work_hours_person_id_week_start_pk" PRIMARY KEY("person_id","week_start"),
	CONSTRAINT "work_hours_minutes_ck" CHECK ("work_hours"."minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_card_id_residence_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."residence_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_images" ADD CONSTRAINT "card_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_images" ADD CONSTRAINT "card_images_card_id_residence_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."residence_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_counts" ADD CONSTRAINT "daily_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD CONSTRAINT "residence_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD CONSTRAINT "residence_cards_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_price_overrides" ADD CONSTRAINT "tenant_price_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_price_overrides" ADD CONSTRAINT "tenant_price_overrides_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sites" ADD CONSTRAINT "user_sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sites" ADD CONSTRAINT "user_sites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sites" ADD CONSTRAINT "user_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_card_id_residence_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."residence_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_uq" ON "alerts" USING btree ("person_id","type","due_date");--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "alerts" USING btree ("tenant_id","due_date") WHERE "alerts"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_at_idx" ON "audit_logs" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_periods_uq" ON "billing_periods" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX "card_images_card_idx" ON "card_images" USING btree ("card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_employee_code_uq" ON "persons" USING btree ("tenant_id","employee_code");--> statement-breakpoint
CREATE INDEX "persons_tenant_site_status_idx" ON "persons" USING btree ("tenant_id","site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "residence_cards_current_uq" ON "residence_cards" USING btree ("person_id") WHERE "residence_cards"."is_current";--> statement-breakpoint
CREATE INDEX "residence_cards_hmac_idx" ON "residence_cards" USING btree ("tenant_id","card_number_hmac");--> statement-breakpoint
CREATE INDEX "residence_cards_expiry_idx" ON "residence_cards" USING btree ("tenant_id","expiry_date") WHERE "residence_cards"."is_current";--> statement-breakpoint
CREATE INDEX "sites_tenant_idx" ON "sites" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "verifications_card_idx" ON "verifications" USING btree ("card_id","performed_at");