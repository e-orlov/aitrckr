/**
 * Server functions for the Sentiment page: the selected-period overview and
 * the lazily loaded highest/lowest evidence for one entity. Both are
 * read-only — no provider call, no job enqueue, no backfill trigger — and
 * authorize the brand before any business read. There is deliberately no
 * search-query or model input: the page has neither control.
 */
import { createServerFn } from "@tanstack/react-start";
import { SENTIMENT_ASPECT_KEYS } from "@workspace/lib/sentiment/types";
import { z } from "zod";
import { requireAuthSession, requireBrandAccess } from "@/lib/auth/helpers";
import type { LookbackPeriod } from "@/lib/chart-utils";
import { LOOKBACK } from "@/server/analysis";
import {
	loadSentimentEvidence,
	loadSentimentOverview,
	type SentimentEvidenceResponse,
	type SentimentOverviewResponse,
} from "@/server/sentiment-load";

export type {
	SentimentAspectFilter,
	SentimentEntityRow,
	SentimentEvidenceItem,
	SentimentEvidenceResponse,
	SentimentOverviewResponse,
	SentimentSeriesPoint,
} from "@/server/sentiment-load";

export const SENTIMENT_ASPECT_FILTER = z.enum(["overall", ...SENTIMENT_ASPECT_KEYS]);

const scopeSchema = {
	brandId: z.string(),
	lookback: LOOKBACK.default("1m"),
	tags: z.string().optional(),
	aspect: SENTIMENT_ASPECT_FILTER.default("overall"),
	timezone: z.string().default("UTC"),
};

export const getSentimentOverviewFn = createServerFn({ method: "GET" })
	.validator(z.object(scopeSchema))
	.handler(async ({ data }): Promise<SentimentOverviewResponse> => {
		const session = await requireAuthSession();
		await requireBrandAccess(session.user.id, data.brandId);
		return loadSentimentOverview({
			brandId: data.brandId,
			lookback: data.lookback as LookbackPeriod,
			tags: data.tags,
			aspect: data.aspect,
			timezone: data.timezone,
		});
	});

export const SENTIMENT_EVIDENCE_LIMIT = 10;

export const getSentimentEvidenceFn = createServerFn({ method: "GET" })
	.validator(
		z.object({
			...scopeSchema,
			// `brand` or a competitor uuid; the loader re-checks that the competitor belongs to the brand.
			entityKey: z.string().min(1).max(64),
			limit: z.number().int().min(1).max(SENTIMENT_EVIDENCE_LIMIT).default(SENTIMENT_EVIDENCE_LIMIT),
		}),
	)
	.handler(async ({ data }): Promise<SentimentEvidenceResponse> => {
		const session = await requireAuthSession();
		await requireBrandAccess(session.user.id, data.brandId);
		return loadSentimentEvidence({
			brandId: data.brandId,
			lookback: data.lookback as LookbackPeriod,
			tags: data.tags,
			aspect: data.aspect,
			timezone: data.timezone,
			entityKey: data.entityKey,
			limit: data.limit,
		});
	});
