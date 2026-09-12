CREATE TABLE "prompt_run_entity_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_run_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"competitor_id" uuid,
	"entity_key" text NOT NULL,
	"entity_name" text NOT NULL,
	"detector_version" text NOT NULL,
	"matched_terms" text[] DEFAULT '{}' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_run_entity_mentions_entity_type_check" CHECK ("prompt_run_entity_mentions"."entity_type" IN ('brand', 'competitor')),
	CONSTRAINT "prompt_run_entity_mentions_entity_identity_check" CHECK (("prompt_run_entity_mentions"."entity_type" = 'brand' AND "prompt_run_entity_mentions"."competitor_id" IS NULL AND "prompt_run_entity_mentions"."entity_key" = 'brand') OR ("prompt_run_entity_mentions"."entity_type" = 'competitor' AND "prompt_run_entity_mentions"."competitor_id" IS NOT NULL AND "prompt_run_entity_mentions"."entity_key" = "prompt_run_entity_mentions"."competitor_id"::text))
);
--> statement-breakpoint
ALTER TABLE "prompt_run_entity_mentions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_run_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"classifier_version" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"input_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"model" text,
	"web_search" boolean,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_analyses_status_check" CHECK ("sentiment_analyses"."status" IN ('pending', 'processing', 'completed', 'no_mentions', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "sentiment_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_aspect_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"taxonomy_version" text NOT NULL,
	"aspect_key" text NOT NULL,
	"aspect_label" text NOT NULL,
	"score" smallint NOT NULL,
	"category" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_aspect_observations_aspect_key_check" CHECK ("sentiment_aspect_observations"."aspect_key" IN ('price', 'coverage', 'service', 'other')),
	CONSTRAINT "sentiment_aspect_observations_score_check" CHECK ("sentiment_aspect_observations"."score" >= 0 AND "sentiment_aspect_observations"."score" <= 100),
	CONSTRAINT "sentiment_aspect_observations_category_check" CHECK (("sentiment_aspect_observations"."category" = 'positive' AND "sentiment_aspect_observations"."score" >= 51) OR ("sentiment_aspect_observations"."category" = 'negative' AND "sentiment_aspect_observations"."score" <= 49) OR ("sentiment_aspect_observations"."category" IN ('neutral', 'mixed') AND "sentiment_aspect_observations"."score" = 50)),
	CONSTRAINT "sentiment_aspect_observations_confidence_check" CHECK ("sentiment_aspect_observations"."confidence" >= 0 AND "sentiment_aspect_observations"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "sentiment_aspect_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_run_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"detector_version" text NOT NULL,
	"status" text NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_detections_status_check" CHECK ("sentiment_detections"."status" IN ('mentions', 'no_mentions', 'unextractable')),
	CONSTRAINT "sentiment_detections_mention_count_check" CHECK ("sentiment_detections"."mention_count" >= 0 AND (("sentiment_detections"."status" = 'mentions') = ("sentiment_detections"."mention_count" > 0)))
);
--> statement-breakpoint
ALTER TABLE "sentiment_detections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sentiment_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"mention_id" uuid NOT NULL,
	"prompt_run_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"competitor_id" uuid,
	"entity_key" text NOT NULL,
	"score" smallint NOT NULL,
	"category" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sentiment_observations_score_check" CHECK ("sentiment_observations"."score" >= 0 AND "sentiment_observations"."score" <= 100),
	CONSTRAINT "sentiment_observations_category_check" CHECK (("sentiment_observations"."category" = 'positive' AND "sentiment_observations"."score" >= 51) OR ("sentiment_observations"."category" = 'negative' AND "sentiment_observations"."score" <= 49) OR ("sentiment_observations"."category" IN ('neutral', 'mixed') AND "sentiment_observations"."score" = 50)),
	CONSTRAINT "sentiment_observations_confidence_check" CHECK ("sentiment_observations"."confidence" >= 0 AND "sentiment_observations"."confidence" <= 1),
	CONSTRAINT "sentiment_observations_entity_identity_check" CHECK (("sentiment_observations"."entity_type" = 'brand' AND "sentiment_observations"."competitor_id" IS NULL AND "sentiment_observations"."entity_key" = 'brand') OR ("sentiment_observations"."entity_type" = 'competitor' AND "sentiment_observations"."competitor_id" IS NOT NULL AND "sentiment_observations"."entity_key" = "sentiment_observations"."competitor_id"::text))
);
--> statement-breakpoint
ALTER TABLE "sentiment_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prompt_run_entity_mentions" ADD CONSTRAINT "prompt_run_entity_mentions_prompt_run_id_prompt_runs_id_fk" FOREIGN KEY ("prompt_run_id") REFERENCES "public"."prompt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_run_entity_mentions" ADD CONSTRAINT "prompt_run_entity_mentions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_run_entity_mentions" ADD CONSTRAINT "prompt_run_entity_mentions_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_analyses" ADD CONSTRAINT "sentiment_analyses_prompt_run_id_prompt_runs_id_fk" FOREIGN KEY ("prompt_run_id") REFERENCES "public"."prompt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_analyses" ADD CONSTRAINT "sentiment_analyses_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_aspect_observations" ADD CONSTRAINT "sentiment_aspect_observations_observation_id_sentiment_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."sentiment_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_detections" ADD CONSTRAINT "sentiment_detections_prompt_run_id_prompt_runs_id_fk" FOREIGN KEY ("prompt_run_id") REFERENCES "public"."prompt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_detections" ADD CONSTRAINT "sentiment_detections_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_observations" ADD CONSTRAINT "sentiment_observations_analysis_id_sentiment_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."sentiment_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_observations" ADD CONSTRAINT "sentiment_observations_mention_id_prompt_run_entity_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."prompt_run_entity_mentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_observations" ADD CONSTRAINT "sentiment_observations_prompt_run_id_prompt_runs_id_fk" FOREIGN KEY ("prompt_run_id") REFERENCES "public"."prompt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_observations" ADD CONSTRAINT "sentiment_observations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentiment_observations" ADD CONSTRAINT "sentiment_observations_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_run_entity_mentions_run_entity_idx" ON "prompt_run_entity_mentions" USING btree ("prompt_run_id","entity_key");--> statement-breakpoint
CREATE INDEX "prompt_run_entity_mentions_brand_entity_idx" ON "prompt_run_entity_mentions" USING btree ("brand_id","entity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_analyses_run_version_idx" ON "sentiment_analyses" USING btree ("prompt_run_id","classifier_version");--> statement-breakpoint
CREATE INDEX "sentiment_analyses_brand_status_idx" ON "sentiment_analyses" USING btree ("brand_id","classifier_version","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_aspect_observations_observation_aspect_idx" ON "sentiment_aspect_observations" USING btree ("observation_id","taxonomy_version","aspect_key");--> statement-breakpoint
CREATE INDEX "sentiment_aspect_observations_aspect_score_idx" ON "sentiment_aspect_observations" USING btree ("taxonomy_version","aspect_key","score");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_detections_run_version_idx" ON "sentiment_detections" USING btree ("prompt_run_id","detector_version");--> statement-breakpoint
CREATE INDEX "sentiment_detections_brand_version_status_idx" ON "sentiment_detections" USING btree ("brand_id","detector_version","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sentiment_observations_analysis_entity_idx" ON "sentiment_observations" USING btree ("analysis_id","entity_key");--> statement-breakpoint
CREATE INDEX "sentiment_observations_brand_entity_run_idx" ON "sentiment_observations" USING btree ("brand_id","entity_key","prompt_run_id");--> statement-breakpoint
CREATE INDEX "sentiment_observations_brand_entity_score_idx" ON "sentiment_observations" USING btree ("brand_id","entity_key","score");