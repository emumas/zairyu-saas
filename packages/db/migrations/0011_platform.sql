CREATE TABLE "platform_audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_operators" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "platform_audit_logs_at_idx" ON "platform_audit_logs" USING btree ("at");