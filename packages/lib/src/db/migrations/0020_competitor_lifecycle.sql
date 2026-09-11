ALTER TABLE "competitors" ADD COLUMN "previous_names" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "competitors_brand_id_active_idx" ON "competitors" USING btree ("brand_id","active");