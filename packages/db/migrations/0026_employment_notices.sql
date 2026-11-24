CREATE TABLE "employment_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_date" date NOT NULL,
	"status" text NOT NULL,
	"submitted_on" date,
	"method" text,
	"receipt_no" text,
	"note" text,
	"recorded_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_notices_kind_ck" CHECK ("employment_notices"."kind" in ('hire', 'separation')),
	CONSTRAINT "employment_notices_status_ck" CHECK ("employment_notices"."status" in ('submitted', 'not_required'))
);
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "employment_insured" boolean;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "official_name" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "insurance_office_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "employer_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "employer_address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "employer_phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "representative_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notices_from" date DEFAULT current_date NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_notices" ADD CONSTRAINT "employment_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_notices" ADD CONSTRAINT "employment_notices_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_notices" ADD CONSTRAINT "employment_notices_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_notices_event_uq" ON "employment_notices" USING btree ("person_id","kind","event_date");--> statement-breakpoint
CREATE INDEX "employment_notices_tenant_idx" ON "employment_notices" USING btree ("tenant_id");