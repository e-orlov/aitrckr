CREATE TABLE "source_domain_classifications" (
	"hostname" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reason" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"classifier_version" text NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_domain_classifications_category_check" CHECK ("source_domain_classifications"."category" IN ('editorial', 'institutional', 'other')),
	CONSTRAINT "source_domain_classifications_confidence_check" CHECK ("source_domain_classifications"."confidence" >= 0 AND "source_domain_classifications"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "source_domain_classifications" ENABLE ROW LEVEL SECURITY;