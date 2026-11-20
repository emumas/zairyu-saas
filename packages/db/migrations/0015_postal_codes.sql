CREATE TABLE "postal_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"pref" text NOT NULL,
	"city" text NOT NULL,
	"town" text NOT NULL,
	"town_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "postal_code" text;--> statement-breakpoint
CREATE INDEX "postal_codes_pref_city_idx" ON "postal_codes" USING btree ("pref","city");--> statement-breakpoint
CREATE INDEX "postal_codes_code_idx" ON "postal_codes" USING btree ("code");