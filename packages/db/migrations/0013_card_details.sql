ALTER TABLE "residence_cards" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "sex" text;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "nationality" text;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "address_enc" "bytea";--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "address_source" text;--> statement-breakpoint
ALTER TABLE "residence_cards" ADD COLUMN "address_written_at" date;