CREATE TABLE "job_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"name" text NOT NULL,
	"simple_work" boolean DEFAULT false NOT NULL,
	"adult_entertainment" boolean DEFAULT false NOT NULL,
	"ssw_field" text,
	"note" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"job_category_id" uuid NOT NULL,
	"status_of_residence" text,
	"result" text NOT NULL,
	"items" jsonb NOT NULL,
	"note" text,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_checks_result_ck" CHECK ("job_checks"."result" in ('ok', 'concern'))
);
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "job_category_id" uuid;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "ssw_field" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "job_matching_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_categories" ADD CONSTRAINT "job_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_job_category_id_job_categories_id_fk" FOREIGN KEY ("job_category_id") REFERENCES "public"."job_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_categories_tenant_idx" ON "job_categories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "job_checks_person_idx" ON "job_checks" USING btree ("tenant_id","person_id","checked_at");