CREATE TABLE "sentiment_filtered_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_key" text NOT NULL,
	"aspect_key" text NOT NULL,
	"validation_code" text NOT NULL,
	"classifier_version" text NOT NULL,
	"anchor_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_filtered_claims_aspect_key_check" CHECK ("sentiment_filtered_claims"."aspect_key" IN ('price', 'coverage', 'service', 'other')),
	CONSTRAINT "sentiment_filtered_claims_entity_type_check" CHECK ("sentiment_filtered_claims"."entity_type" IN ('brand', 'competitor')),
	CONSTRAINT "sentiment_filtered_claims_validation_code_check" CHECK ("sentiment_filtered_claims"."validation_code" IN ('aspect-ungrounded', 'evidence-entity-unbound', 'polarity-category-mismatch', 'mixed-needs-dual-evidence', 'evidence-anchor-polarity-conflict'))
);
--> statement-breakpoint
ALTER TABLE "sentiment_filtered_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_provider_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"phase" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"generation_id" text,
	"input_hash" text NOT NULL,
	"outcome" text DEFAULT 'sending' NOT NULL,
	"actual_cost_usd" numeric(10, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sentiment_provider_attempts_phase_check" CHECK ("sentiment_provider_attempts"."phase" IN ('classify', 'repair', 'verify')),
	CONSTRAINT "sentiment_provider_attempts_outcome_check" CHECK ("sentiment_provider_attempts"."outcome" IN ('sending', 'accepted', 'rejected', 'provider-error', 'aborted')),
	CONSTRAINT "sentiment_provider_attempts_ordinal_check" CHECK ("sentiment_provider_attempts"."ordinal" >= 1),
	CONSTRAINT "sentiment_provider_attempts_cost_check" CHECK ("sentiment_provider_attempts"."actual_cost_usd" IS NULL OR "sentiment_provider_attempts"."actual_cost_usd" >= 0),
	CONSTRAINT "sentiment_provider_attempts_generation_check" CHECK ("sentiment_provider_attempts"."generation_id" IS NULL OR "sentiment_provider_attempts"."generation_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_resolution_cases" (
	"analysis_id" uuid PRIMARY KEY NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"provisional_result" jsonb,
	"unresolved_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"automated_provider_calls" integer DEFAULT 0 NOT NULL,
	"total_actual_cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_resolution_cases_status_check" CHECK ("sentiment_resolution_cases"."status" IN ('open', 'repairing', 'verifying', 'retry_wait', 'awaiting_review', 'awaiting_reconciliation', 'resolved')),
	CONSTRAINT "sentiment_resolution_cases_calls_check" CHECK ("sentiment_resolution_cases"."automated_provider_calls" >= 0),
	CONSTRAINT "sentiment_resolution_cases_cost_check" CHECK ("sentiment_resolution_cases"."total_actual_cost_usd" >= 0),
	CONSTRAINT "sentiment_resolution_cases_review_reason_check" CHECK ("sentiment_resolution_cases"."review_reason" IS NULL OR "sentiment_resolution_cases"."review_reason" IN ('call-limit', 'cost-limit', 'contract-defect', 'unknown-provider-outcome', 'initial-classification-limit'))
);
--> statement-breakpoint
ALTER TABLE "sentiment_resolution_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sentiment_analyses" ADD COLUMN "verifier_version" text;--> statement-breakpoint
ALTER TABLE "sentiment_analyses" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sentiment_filtered_claims" ADD CONSTRAINT "sentiment_filtered_claims_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_provider_attempts" ADD CONSTRAINT "sentiment_provider_attempts_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_resolution_cases" ADD CONSTRAINT "sentiment_resolution_cases_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_filtered_claims_analysis_aspect_idx" ON "sentiment_filtered_claims" USING btree ("analysis_id","entity_key","aspect_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_provider_attempts_analysis_ordinal_idx" ON "sentiment_provider_attempts" USING btree ("analysis_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_provider_attempts_generation_idx" ON "sentiment_provider_attempts" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "sentiment_resolution_cases_status_idx" ON "sentiment_resolution_cases" USING btree ("status","next_attempt_at");