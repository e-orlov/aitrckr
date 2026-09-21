CREATE TABLE "sentiment_alert_state" (
	"signal" text PRIMARY KEY NOT NULL,
	"baseline" jsonb,
	"watermark" jsonb,
	"evaluated_at" timestamp with time zone,
	"last_alerted_at" timestamp with time zone,
	"cooldown_until" timestamp with time zone,
	"updated_by" text,
	"correlation_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sentiment_alert_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"seq" integer NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"correlation_id" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_control_events_kind_check" CHECK ("sentiment_control_events"."subject_kind" IN ('control', 'permit', 'breaker', 'alert')),
	CONSTRAINT "sentiment_control_events_seq_check" CHECK ("sentiment_control_events"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "sentiment_control_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_controls" (
	"key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"epoch" integer NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"correlation_id" text NOT NULL,
	CONSTRAINT "sentiment_controls_state_check" CHECK ("sentiment_controls"."state" IN ('held', 'open')),
	CONSTRAINT "sentiment_controls_epoch_check" CHECK ("sentiment_controls"."epoch" >= 1)
);
--> statement-breakpoint
ALTER TABLE "sentiment_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_dispatch_permits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"prompt_run_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"classifier_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"phase_budget" jsonb NOT NULL,
	"estimated_cost_budget_usd" numeric(10, 6) NOT NULL,
	"settled_cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"reserved_estimate_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_by" text NOT NULL,
	"reason" text NOT NULL,
	"correlation_id" text NOT NULL,
	"contract_sha256" text,
	CONSTRAINT "sentiment_dispatch_permits_purpose_check" CHECK ("sentiment_dispatch_permits"."purpose" IN ('canary', 'resume-verify')),
	CONSTRAINT "sentiment_dispatch_permits_state_check" CHECK ("sentiment_dispatch_permits"."state" IN ('issued', 'active', 'exhausted', 'expired', 'revoked')),
	CONSTRAINT "sentiment_dispatch_permits_budget_check" CHECK ("sentiment_dispatch_permits"."estimated_cost_budget_usd" > 0 AND "sentiment_dispatch_permits"."estimated_cost_budget_usd" <= 0.10),
	CONSTRAINT "sentiment_dispatch_permits_amounts_check" CHECK ("sentiment_dispatch_permits"."settled_cost_usd" >= 0 AND "sentiment_dispatch_permits"."reserved_estimate_usd" >= 0),
	CONSTRAINT "sentiment_dispatch_permits_phase_budget_check" CHECK (jsonb_typeof("sentiment_dispatch_permits"."phase_budget") = 'object' AND ("sentiment_dispatch_permits"."phase_budget" - 'classify' - 'repair' - 'verify') = '{}'::jsonb AND coalesce(("sentiment_dispatch_permits"."phase_budget"->>'classify')::int, 0) IN (0, 1) AND coalesce(("sentiment_dispatch_permits"."phase_budget"->>'repair')::int, 0) IN (0, 1) AND coalesce(("sentiment_dispatch_permits"."phase_budget"->>'verify')::int, 0) IN (0, 1))
);
--> statement-breakpoint
ALTER TABLE "sentiment_dispatch_permits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_provider_breakers" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"schema_fp" text NOT NULL,
	"request_profile" jsonb NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"opened_at" timestamp with time zone,
	"open_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"probe_attempt_id" uuid,
	"probe_generation" integer DEFAULT 0 NOT NULL,
	"probe_lease_until" timestamp with time zone,
	"opened_class" text,
	"opened_phase" text,
	"last_attempt_id" uuid,
	"last_http_status" integer,
	"last_error_type" text,
	"last_rule" text,
	"last_changed_by" text NOT NULL,
	"last_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_provider_breakers_state_check" CHECK ("sentiment_provider_breakers"."state" IN ('closed', 'open', 'half_open')),
	CONSTRAINT "sentiment_provider_breakers_failures_check" CHECK ("sentiment_provider_breakers"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sentiment_provider_breakers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sentiment_resolution_cases" DROP CONSTRAINT "sentiment_resolution_cases_review_reason_check";--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD COLUMN "permit_id" uuid;--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD COLUMN "schema_fp" text;--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD COLUMN "reserved_estimate_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "sentiment_dispatch_permits" ADD CONSTRAINT "sentiment_dispatch_permits_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_control_events_subject_seq_idx" ON "sentiment_control_events" USING btree ("subject_kind","subject_key","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_dispatch_permits_live_idx" ON "sentiment_dispatch_permits" USING btree ("analysis_id","instance_id") WHERE "sentiment_dispatch_permits"."state" IN ('issued', 'active');--> statement-breakpoint
CREATE INDEX "sentiment_dispatch_permits_analysis_idx" ON "sentiment_dispatch_permits" USING btree ("analysis_id","state");--> statement-breakpoint
CREATE INDEX "sentiment_provider_breakers_schema_fp_idx" ON "sentiment_provider_breakers" USING btree ("schema_fp");--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD CONSTRAINT "sentiment_provider_attempts_permit_id_sentiment_dispatch_permits_id_fk" FOREIGN KEY ("permit_id") REFERENCES "public"."sentiment_dispatch_permits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_resolution_cases" ADD CONSTRAINT "sentiment_resolution_cases_review_reason_check" CHECK ("sentiment_resolution_cases"."review_reason" IS NULL OR "sentiment_resolution_cases"."review_reason" IN ('call-limit', 'cost-limit', 'contract-defect', 'unknown-provider-outcome', 'initial-classification-limit', 'retry-exhausted'));--> statement-breakpoint
INSERT INTO "sentiment_controls" ("key", "state", "epoch", "actor", "reason", "correlation_id") VALUES ('dispatch', 'held', 1, 'migration', 'Amendment C initial state: sentiment dispatch held until an operator opens it', '0024_sentiment_dispatch_controls') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "sentiment_control_events" ("subject_kind", "subject_key", "seq", "from_state", "to_state", "actor", "reason", "correlation_id") SELECT 'control', 'dispatch', 1, NULL, 'held', 'migration', 'Amendment C initial state: sentiment dispatch held until an operator opens it', '0024_sentiment_dispatch_controls' WHERE NOT EXISTS (SELECT 1 FROM "sentiment_control_events" WHERE "subject_kind" = 'control' AND "subject_key" = 'dispatch');