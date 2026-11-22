CREATE TABLE "study_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_breaks_range_ck" CHECK ("study_breaks"."from_date" <= "study_breaks"."to_date")
);
--> statement-breakpoint
CREATE TABLE "work_days" (
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_days_person_id_work_date_pk" PRIMARY KEY("person_id","work_date"),
	CONSTRAINT "work_days_minutes_ck" CHECK ("work_days"."minutes" between 0 and 1440)
);
--> statement-breakpoint
ALTER TABLE "study_breaks" ADD CONSTRAINT "study_breaks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_breaks" ADD CONSTRAINT "study_breaks_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_days" ADD CONSTRAINT "work_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_days" ADD CONSTRAINT "work_days_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "study_breaks_person_idx" ON "study_breaks" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "work_days_tenant_date_idx" ON "work_days" USING btree ("tenant_id","work_date");