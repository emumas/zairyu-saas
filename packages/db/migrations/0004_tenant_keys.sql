CREATE TYPE "public"."tenant_key_purpose" AS ENUM('data', 'hmac');--> statement-breakpoint
CREATE TABLE "tenant_keys" (
	"tenant_id" uuid DEFAULT (nullif(current_setting('app.tenant_id', true), ''))::uuid NOT NULL,
	"purpose" "tenant_key_purpose" NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_keys_tenant_id_purpose_version_pk" PRIMARY KEY("tenant_id","purpose","version")
);
--> statement-breakpoint
ALTER TABLE "tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_keys_active_uq" ON "tenant_keys" USING btree ("tenant_id","purpose") WHERE "tenant_keys"."active";