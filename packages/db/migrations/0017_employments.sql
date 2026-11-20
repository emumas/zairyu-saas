CREATE TABLE "person_employments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"hired_at" date,
	"retired_at" date NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text,
	"site_id" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "hired_at" date;--> statement-breakpoint
ALTER TABLE "person_employments" ADD CONSTRAINT "person_employments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_employments" ADD CONSTRAINT "person_employments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_employments" ADD CONSTRAINT "person_employments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_employments" ADD CONSTRAINT "person_employments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_employments_person_idx" ON "person_employments" USING btree ("tenant_id","person_id");