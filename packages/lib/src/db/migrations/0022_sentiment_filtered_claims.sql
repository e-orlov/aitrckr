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
ALTER TABLE "sentiment_filtered_claims" ADD CONSTRAINT "sentiment_filtered_claims_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_filtered_claims_analysis_aspect_idx" ON "sentiment_filtered_claims" USING btree ("analysis_id","entity_key","aspect_key");