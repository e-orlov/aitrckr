/**
 * Server-only loaders for the Sentiment page. Lives apart from the server-fn
 * file so the database reads stay strippable from the client bundle (see
 * `server/prompt-resolution.ts` for the why). Every query is bounded SQL
 * aggregation over the brand's stored runs — no raw answer bodies, no
 * classifier metadata and no provider call ever leave this module.
 */
import { activeCompetitorsOf } from "@workspace/lib/db/competitors";
import { db } from "@workspace/lib/db/db";
import {
	brands,
	citations,
	competitors,
	promptRunEntityMentions,
	promptRuns,
	prompts,
	SYSTEM_TAGS,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentDetections,
	sentimentObservations,
} from "@workspace/lib/db/schema";
import { extractAnswerBody } from "@workspace/lib/sentiment";
import {
	bucketForRange,
	computeEntityMetrics,
	type EntityMetrics,
	extremesAllocation,
	LOW_SAMPLE_THRESHOLD,
	type SentimentBucket,
	type SentimentView,
	selectChartRoster,
} from "@workspace/lib/sentiment/metrics";
import {
	BRAND_ENTITY_KEY,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_ASPECTS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAspectKey,
	type SentimentCategory,
	type SentimentEvidence,
} from "@workspace/lib/sentiment/types";
import { getEffectiveBrandedStatus } from "@workspace/lib/tag-utils";
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { PgSelect } from "drizzle-orm/pg-core";
import type { LookbackPeriod } from "@/lib/chart-utils";
import { getTimezoneLookbackRange, resolveTimezone } from "@/lib/timezone-utils";

export type SentimentAspectFilter = "overall" | SentimentAspectKey;

export interface SentimentScope {
	brandId: string;
	lookback: LookbackPeriod;
	tags?: string;
	aspect: SentimentAspectFilter;
	timezone: string;
}

/**
 * One leaderboard row. Three counts are kept apart on purpose (see
 * `EntityCounts` in the metrics module): `mentions` (M) and `classified` (C)
 * are aspect-independent, `sample` (S) is what the displayed score rests on
 * — every classified mention in the overall view, only the mentions whose
 * answer evaluated the selected aspect in an aspect view.
 */
export interface SentimentEntityRow {
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	name: string;
	isBrand: boolean;
	/** Distinct responses mentioning the entity (`M`). */
	mentions: number;
	/** Mentions with a completed current-version entity classification (`C`). */
	classified: number;
	/** Observations in the selected view (`S`): `classified` overall, the aspect's observations otherwise. */
	sample: number;
	/** Category counts over the sample. */
	counts: { positive: number; neutral: number; mixed: number; negative: number };
	metrics: EntityMetrics;
	/** Fewer than `LOW_SAMPLE_THRESHOLD` observations in the sample. */
	lowSample: boolean;
}

export interface SentimentSeriesPoint {
	bucketStart: string;
	/** Per roster entity: mean score over the bucket's sample and that sample's size. */
	values: Record<string, { sentiment: number | null; sample: number }>;
}

export interface SentimentOverviewResponse {
	brand: { id: string; name: string };
	dateRange: { fromDate: string; toDate: string; timezone: string };
	aspect: SentimentAspectFilter;
	/** Label of the selected aspect (`null` in the overall view) for sample wording. */
	aspectLabel: string | null;
	availableAspects: { key: SentimentAspectKey; label: string; count: number }[];
	/** Eligible stored responses in scope (`T`). */
	eligibleResponses: number;
	coverage: {
		/** Responses in scope with a completed current-version detection receipt (any status). */
		responsesDetected: number;
		/** Responses whose receipt found at least one entity. */
		responsesWithMentions: number;
		/** Responses whose receipt says the stored output had no extractable answer text. */
		responsesUnextractable: number;
		analyses: { completed: number; pending: number; failed: number; noMentions: number };
	};
	entities: SentimentEntityRow[];
	/** Entity keys drawn on the radial and the trend; own brand first. */
	chartRoster: string[];
	bucket: SentimentBucket;
	series: SentimentSeriesPoint[];
}

export interface SentimentEvidenceItem {
	observationId: string;
	promptRunId: string;
	promptId: string;
	promptText: string;
	tags: string[];
	runCreatedAt: string;
	score: number;
	category: SentimentCategory;
	/** Exact excerpts with raw-body offsets and polarity. */
	evidence: SentimentEvidence[];
	/**
	 * A short window of the stored answer around the first excerpt. Raw offset
	 * `excerptStart` maps evidence offsets onto it: an excerpt character at
	 * index `i` is raw offset `excerptStart + i` (the leading ellipsis, when
	 * present, is accounted for).
	 */
	excerpt: string;
	excerptStart: number;
	aspects: { key: SentimentAspectKey; label: string; score: number; category: SentimentCategory }[];
	/** The monitoring answer's own citations — deduplicated and bounded; never classifier search results. */
	sources: { url: string; domain: string; title: string | null }[];
}

export interface SentimentEvidenceResponse {
	entity: { key: string; name: string };
	aspect: SentimentAspectFilter;
	totalObservations: number;
	highest: SentimentEvidenceItem[];
	lowest: SentimentEvidenceItem[];
}

const EXCERPT_RADIUS = 160;
/** Original citations returned per stored answer in the evidence cards. */
export const EVIDENCE_SOURCES_PER_RUN = 8;

const viewOf = (aspect: SentimentAspectFilter): SentimentView => (aspect === "overall" ? "overall" : "aspect");

function dayAfter(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const next = new Date(Date.UTC(y, m - 1, d + 1));
	return next.toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number {
	const [fy, fm, fd] = fromDate.split("-").map(Number);
	const [ty, tm, td] = toDate.split("-").map(Number);
	return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/**
 * Concrete window in the caller's timezone. "All time" means every stored
 * run of the brand, so its lower bound is the brand's earliest run date, not
 * a fixed year.
 */
async function resolveSentimentRange(brandId: string, lookback: LookbackPeriod, timezoneParam: string) {
	const timezone = resolveTimezone(timezoneParam);
	const range = getTimezoneLookbackRange(lookback, timezone);
	const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
	if (range.fromDateStr && range.toDateStr) return { timezone, fromDate: range.fromDateStr, toDate: range.toDateStr };
	const [earliest] = await db
		.select({ first: sql<string | null>`to_char(min(${promptRuns.createdAt}) at time zone ${timezone}, 'YYYY-MM-DD')` })
		.from(promptRuns)
		.where(eq(promptRuns.brandId, brandId));
	return { timezone, fromDate: earliest?.first ?? todayStr, toDate: todayStr };
}

/** Prompt ids matching the Tags filter, over ALL of the brand's prompts (disabled ones keep their history). */
async function resolveTaggedPromptIds(brandId: string, tags: string | undefined): Promise<string[] | null> {
	const tagFilter = tags?.split(",").filter(Boolean) ?? [];
	if (tagFilter.length === 0) return null;
	const rows = await db
		.select({ id: prompts.id, tags: prompts.tags, systemTags: prompts.systemTags })
		.from(prompts)
		.where(eq(prompts.brandId, brandId));
	return rows
		.filter((p) => {
			const userTags = p.tags ?? [];
			const { isBranded } = getEffectiveBrandedStatus(p.systemTags ?? [], userTags);
			const systemTag = isBranded ? SYSTEM_TAGS.BRANDED : SYSTEM_TAGS.UNBRANDED;
			const effective = userTags.includes(systemTag) ? userTags : [...userTags, systemTag];
			return tagFilter.some((t) => effective.includes(t));
		})
		.map((p) => p.id);
}

interface ScopeSql {
	/** Predicate on `prompt_runs` rows for the brand, window and tag filter. */
	runsWhere: SQL;
	timezone: string;
}

function scopeRuns(
	brandId: string,
	fromDate: string,
	toDate: string,
	timezone: string,
	promptIds: string[] | null,
): ScopeSql {
	const lower = sql`(${fromDate}::date)::timestamp at time zone ${timezone}`;
	const upper = sql`(${dayAfter(toDate)}::date)::timestamp at time zone ${timezone}`;
	const parts: SQL[] = [
		eq(promptRuns.brandId, brandId),
		gte(promptRuns.createdAt, lower),
		lt(promptRuns.createdAt, upper),
	];
	if (promptIds !== null) parts.push(promptIds.length === 0 ? sql`false` : inArray(promptRuns.promptId, promptIds));
	return { runsWhere: and(...parts) as SQL, timezone };
}

const runIdsInScope = (scope: ScopeSql) => db.select({ id: promptRuns.id }).from(promptRuns).where(scope.runsWhere);

/** Completed current-version analyses only; a stale taxonomy never counts as current. */
function completedObservationsWhere(aspect: SentimentAspectFilter, scope: ScopeSql): SQL {
	const base = and(
		eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
		eq(sentimentAnalyses.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
		eq(sentimentAnalyses.status, "completed"),
		inArray(sentimentObservations.promptRunId, runIdsInScope(scope)),
	) as SQL;
	if (aspect === "overall") return base;
	return and(
		base,
		eq(sentimentAspectObservations.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
		eq(sentimentAspectObservations.aspectKey, aspect),
	) as SQL;
}

/** Score/category columns for the selected view: entity observations or one aspect's rows. */
function scoreColumns(aspect: SentimentAspectFilter) {
	return aspect === "overall"
		? { score: sentimentObservations.score, category: sentimentObservations.category }
		: { score: sentimentAspectObservations.score, category: sentimentAspectObservations.category };
}

/** For an aspect view, join that aspect's rows onto an observations query; the overall view needs no join. */
function joinAspect<Q extends PgSelect>(query: Q, aspect: SentimentAspectFilter): Q {
	if (aspect === "overall") return query;
	return query.innerJoin(
		sentimentAspectObservations,
		eq(sentimentAspectObservations.observationId, sentimentObservations.id),
	) as unknown as Q;
}

const withAnalysis = eq(sentimentAnalyses.id, sentimentObservations.analysisId);

interface AggRow {
	entityKey: string;
	sample: number;
	scoreSum: number;
	positive: number;
	neutral: number;
	mixed: number;
	negative: number;
}

async function aggregateByEntity(aspect: SentimentAspectFilter, scope: ScopeSql): Promise<Map<string, AggRow>> {
	const { score, category } = scoreColumns(aspect);
	const rows: AggRow[] = await joinAspect(
		db
			.select({
				entityKey: sentimentObservations.entityKey,
				sample: sql<number>`count(*)::int`,
				scoreSum: sql<number>`coalesce(sum(${score}), 0)::int`,
				positive: sql<number>`count(*) filter (where ${category} = 'positive')::int`,
				neutral: sql<number>`count(*) filter (where ${category} = 'neutral')::int`,
				mixed: sql<number>`count(*) filter (where ${category} = 'mixed')::int`,
				negative: sql<number>`count(*) filter (where ${category} = 'negative')::int`,
			})
			.from(sentimentObservations)
			.innerJoin(sentimentAnalyses, withAnalysis)
			.$dynamic(),
		aspect,
	)
		.where(completedObservationsWhere(aspect, scope))
		.groupBy(sentimentObservations.entityKey);
	return new Map(rows.map((row) => [row.entityKey, row]));
}

async function mentionsByEntity(scope: ScopeSql): Promise<Map<string, number>> {
	const rows = await db
		.select({
			entityKey: promptRunEntityMentions.entityKey,
			mentions: sql<number>`count(distinct ${promptRunEntityMentions.promptRunId})::int`,
		})
		.from(promptRunEntityMentions)
		.where(
			and(
				eq(promptRunEntityMentions.detectorVersion, SENTIMENT_DETECTOR_VERSION),
				inArray(promptRunEntityMentions.promptRunId, runIdsInScope(scope)),
			),
		)
		.groupBy(promptRunEntityMentions.entityKey);
	return new Map(rows.map((row) => [row.entityKey, row.mentions]));
}

async function coverageStats(scope: ScopeSql) {
	const [receipts, statuses] = await Promise.all([
		db
			.select({ status: sentimentDetections.status, value: sql<number>`count(*)::int` })
			.from(sentimentDetections)
			.where(
				and(
					eq(sentimentDetections.detectorVersion, SENTIMENT_DETECTOR_VERSION),
					inArray(sentimentDetections.promptRunId, runIdsInScope(scope)),
				),
			)
			.groupBy(sentimentDetections.status),
		db
			.select({ status: sentimentAnalyses.status, value: sql<number>`count(*)::int` })
			.from(sentimentAnalyses)
			.where(
				and(
					eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
					inArray(sentimentAnalyses.promptRunId, runIdsInScope(scope)),
				),
			)
			.groupBy(sentimentAnalyses.status),
	]);
	const byReceipt = new Map(receipts.map((row) => [row.status, row.value]));
	const byStatus = new Map(statuses.map((row) => [row.status, row.value]));
	const withMentions = byReceipt.get("mentions") ?? 0;
	const unextractable = byReceipt.get("unextractable") ?? 0;
	return {
		responsesDetected: withMentions + unextractable + (byReceipt.get("no_mentions") ?? 0),
		responsesWithMentions: withMentions,
		responsesUnextractable: unextractable,
		analyses: {
			completed: byStatus.get("completed") ?? 0,
			pending: (byStatus.get("pending") ?? 0) + (byStatus.get("processing") ?? 0),
			failed: byStatus.get("failed") ?? 0,
			noMentions: byStatus.get("no_mentions") ?? 0,
		},
	};
}

async function availableAspects(scope: ScopeSql) {
	const rows = await db
		.select({ key: sentimentAspectObservations.aspectKey, count: sql<number>`count(*)::int` })
		.from(sentimentAspectObservations)
		.innerJoin(sentimentObservations, eq(sentimentObservations.id, sentimentAspectObservations.observationId))
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentObservations.analysisId))
		.where(
			and(
				eq(sentimentAspectObservations.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
				completedObservationsWhere("overall", scope),
			),
		)
		.groupBy(sentimentAspectObservations.aspectKey);
	const counts = new Map(rows.map((row) => [row.key, row.count]));
	return SENTIMENT_ASPECT_KEYS.map((key) => ({
		key,
		label: SENTIMENT_ASPECTS[key].label,
		count: counts.get(key) ?? 0,
	}));
}

function bucketExpression(bucket: SentimentBucket, timezone: string): SQL<string> {
	const local = sql`(${promptRuns.createdAt} at time zone ${timezone})`;
	switch (bucket) {
		case "day":
			return sql<string>`to_char(date_trunc('day', ${local}), 'YYYY-MM-DD')`;
		case "week":
			return sql<string>`to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
		case "month":
			return sql<string>`to_char(date_trunc('month', ${local}), 'YYYY-MM-DD')`;
	}
}

/** Every bucket start between the window bounds, so gaps render as null rather than vanish. */
export function enumerateBuckets(fromDate: string, toDate: string, bucket: SentimentBucket): string[] {
	const out: string[] = [];
	const [fy, fm, fd] = fromDate.split("-").map(Number);
	let cursor = new Date(Date.UTC(fy, fm - 1, fd));
	if (bucket === "week") {
		const dow = (cursor.getUTCDay() + 6) % 7;
		cursor = new Date(cursor.getTime() - dow * 86_400_000);
	} else if (bucket === "month") {
		cursor = new Date(Date.UTC(fy, fm - 1, 1));
	}
	const [ty, tm, td] = toDate.split("-").map(Number);
	const end = new Date(Date.UTC(ty, tm - 1, td));
	while (cursor.getTime() <= end.getTime() && out.length < 400) {
		out.push(cursor.toISOString().slice(0, 10));
		if (bucket === "day") cursor = new Date(cursor.getTime() + 86_400_000);
		else if (bucket === "week") cursor = new Date(cursor.getTime() + 7 * 86_400_000);
		else cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
	}
	return out;
}

async function seriesByBucket(
	aspect: SentimentAspectFilter,
	scope: ScopeSql,
	bucket: SentimentBucket,
	roster: string[],
	buckets: string[],
): Promise<SentimentSeriesPoint[]> {
	if (roster.length === 0 || buckets.length === 0) return [];
	const { score } = scoreColumns(aspect);
	const bucketExpr = bucketExpression(bucket, scope.timezone);
	const rows: { entityKey: string; bucketStart: string; sample: number; scoreSum: number }[] = await joinAspect(
		db
			.select({
				entityKey: sentimentObservations.entityKey,
				bucketStart: bucketExpr.as("bucket_start"),
				sample: sql<number>`count(*)::int`,
				scoreSum: sql<number>`coalesce(sum(${score}), 0)::int`,
			})
			.from(sentimentObservations)
			.innerJoin(sentimentAnalyses, withAnalysis)
			.$dynamic(),
		aspect,
	)
		.innerJoin(promptRuns, eq(promptRuns.id, sentimentObservations.promptRunId))
		.where(and(completedObservationsWhere(aspect, scope), inArray(sentimentObservations.entityKey, roster)))
		// Ordinal grouping: the bucket expression binds the timezone as a parameter,
		// and Postgres would not match a second copy of it in GROUP BY.
		.groupBy(sql`1`, sql`2`);
	const byBucket = new Map<string, Map<string, { sentiment: number | null; sample: number }>>();
	for (const row of rows) {
		const entry = byBucket.get(row.bucketStart) ?? new Map();
		entry.set(row.entityKey, {
			sentiment: row.sample === 0 ? null : row.scoreSum / row.sample,
			sample: row.sample,
		});
		byBucket.set(row.bucketStart, entry);
	}
	return buckets.map((bucketStart) => {
		const values: SentimentSeriesPoint["values"] = {};
		const entry = byBucket.get(bucketStart);
		for (const key of roster) values[key] = entry?.get(key) ?? { sentiment: null, sample: 0 };
		return { bucketStart, values };
	});
}

export async function loadSentimentOverview(scope: SentimentScope): Promise<SentimentOverviewResponse> {
	const { timezone, fromDate, toDate } = await resolveSentimentRange(scope.brandId, scope.lookback, scope.timezone);
	const promptIds = await resolveTaggedPromptIds(scope.brandId, scope.tags);
	const sqlScope = scopeRuns(scope.brandId, fromDate, toDate, timezone, promptIds);
	const view = viewOf(scope.aspect);

	const [brandRows, roster, [eligible], mentions, classifiedAgg, sampleAgg, coverage, aspects] = await Promise.all([
		db.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.id, scope.brandId)).limit(1),
		db
			.select({ id: competitors.id, name: competitors.name })
			.from(competitors)
			.where(activeCompetitorsOf(scope.brandId))
			.orderBy(competitors.createdAt, competitors.id),
		db.select({ value: sql<number>`count(*)::int` }).from(promptRuns).where(sqlScope.runsWhere),
		mentionsByEntity(sqlScope),
		aggregateByEntity("overall", sqlScope),
		view === "overall" ? Promise.resolve(null) : aggregateByEntity(scope.aspect, sqlScope),
		coverageStats(sqlScope),
		availableAspects(sqlScope),
	]);
	const brand = brandRows[0];
	if (!brand) throw new Error("Brand not found");
	const eligibleResponses = eligible?.value ?? 0;
	const samples = sampleAgg ?? classifiedAgg;

	const toRow = (
		key: string,
		entityType: "brand" | "competitor",
		competitorId: string | null,
		name: string,
	): SentimentEntityRow => {
		const agg = samples.get(key);
		const mentionCount = mentions.get(key) ?? 0;
		const classified = classifiedAgg.get(key)?.sample ?? 0;
		const sample = agg?.sample ?? 0;
		const counts = {
			positive: agg?.positive ?? 0,
			neutral: agg?.neutral ?? 0,
			mixed: agg?.mixed ?? 0,
			negative: agg?.negative ?? 0,
		};
		return {
			key,
			entityType,
			competitorId,
			name,
			isBrand: entityType === "brand",
			mentions: mentionCount,
			classified,
			sample,
			counts,
			metrics: computeEntityMetrics({
				eligibleResponses,
				mentions: mentionCount,
				classified,
				sample,
				...counts,
				scoreSum: agg?.scoreSum ?? 0,
			}),
			lowSample: sample > 0 && sample < LOW_SAMPLE_THRESHOLD,
		};
	};
	const brandRow = toRow(BRAND_ENTITY_KEY, "brand", null, brand.name);
	const competitorRows = roster.map((c) => toRow(c.id, "competitor", c.id, c.name));
	const chartRoster = [BRAND_ENTITY_KEY, ...selectChartRoster(competitorRows, 6, view).map((row) => row.key)];

	const bucket = bucketForRange(daysBetween(fromDate, toDate));
	const buckets = enumerateBuckets(fromDate, toDate, bucket);
	const series = await seriesByBucket(scope.aspect, sqlScope, bucket, chartRoster, buckets);

	return {
		brand,
		dateRange: { fromDate, toDate, timezone },
		aspect: scope.aspect,
		aspectLabel: scope.aspect === "overall" ? null : SENTIMENT_ASPECTS[scope.aspect].label,
		availableAspects: aspects,
		eligibleResponses,
		coverage,
		entities: [brandRow, ...competitorRows],
		chartRoster,
		bucket,
		series,
	};
}

export interface SentimentEvidenceScope extends SentimentScope {
	entityKey: string;
	limit: number;
}

/**
 * The answer window around the first excerpt, cut at raw offsets so the
 * client can highlight `evidence[i].start - excerptStart`. Excerpts are
 * stored with raw offsets; nothing is re-searched by text here.
 */
function excerptAround(answer: string, evidence: SentimentEvidence[]): { excerpt: string; excerptStart: number } {
	const first = evidence[0];
	const anchor = first && first.start >= 0 && first.end <= answer.length ? first : null;
	const start = anchor ? Math.max(0, anchor.start - EXCERPT_RADIUS) : 0;
	const end = anchor
		? Math.min(answer.length, anchor.end + EXCERPT_RADIUS)
		: Math.min(answer.length, EXCERPT_RADIUS * 2);
	return {
		excerpt: `${start > 0 ? "…" : ""}${answer.slice(start, end)}${end < answer.length ? "…" : ""}`,
		excerptStart: start > 0 ? start - 1 : 0,
	};
}

interface ExtremeRow {
	observationId: string;
	promptRunId: string;
	promptId: string;
	runCreatedAt: Date;
	score: number;
}

/**
 * The evidence extremes for one entity, bounded in SQL: one COUNT, then two
 * `ORDER BY … LIMIT` queries over the same total order (score, run
 * timestamp, prompt id, run id, observation id). With fewer than `2 × limit`
 * observations `extremesAllocation` splits the records so the two sets never
 * overlap; nothing but the at-most-`2 × limit` selected rows is materialized.
 */
async function loadExtremes(
	scope: SentimentEvidenceScope,
	sqlScope: ScopeSql,
): Promise<{ total: number; highest: ExtremeRow[]; lowest: ExtremeRow[] }> {
	const { score } = scoreColumns(scope.aspect);
	const where = and(
		completedObservationsWhere(scope.aspect, sqlScope),
		eq(sentimentObservations.brandId, scope.brandId),
		eq(sentimentObservations.entityKey, scope.entityKey),
	);
	const [counted]: { total: number }[] = await joinAspect(
		db
			.select({ total: sql<number>`count(*)::int` })
			.from(sentimentObservations)
			.innerJoin(sentimentAnalyses, withAnalysis)
			.$dynamic(),
		scope.aspect,
	).where(where);
	const total = counted?.total ?? 0;
	const { highCount, lowCount } = extremesAllocation(total, scope.limit);
	const selection = {
		observationId: sentimentObservations.id,
		promptRunId: sentimentObservations.promptRunId,
		promptId: promptRuns.promptId,
		runCreatedAt: promptRuns.createdAt,
		score,
	};
	const ordered = (direction: typeof asc | typeof desc, limit: number): Promise<ExtremeRow[]> =>
		limit === 0
			? Promise.resolve([])
			: joinAspect(
					db.select(selection).from(sentimentObservations).innerJoin(sentimentAnalyses, withAnalysis).$dynamic(),
					scope.aspect,
				)
					.innerJoin(promptRuns, eq(promptRuns.id, sentimentObservations.promptRunId))
					.where(where)
					.orderBy(
						direction(score),
						direction(promptRuns.createdAt),
						direction(promptRuns.promptId),
						direction(sentimentObservations.promptRunId),
						direction(sentimentObservations.id),
					)
					.limit(limit);
	const [highest, lowest] = await Promise.all([ordered(desc, highCount), ordered(asc, lowCount)]);
	return { total, highest, lowest };
}

/**
 * `EXPLAIN (ANALYZE, BUFFERS)` of the highest-evidence query exactly as the
 * loader issues it — used by the integration suite to record that the
 * extremes are answered with `Limit` nodes rather than a full materialization.
 */
export async function explainSentimentEvidence(scope: SentimentEvidenceScope): Promise<string[]> {
	const { timezone, fromDate, toDate } = await resolveSentimentRange(scope.brandId, scope.lookback, scope.timezone);
	const promptIds = await resolveTaggedPromptIds(scope.brandId, scope.tags);
	const sqlScope = scopeRuns(scope.brandId, fromDate, toDate, timezone, promptIds);
	const { score } = scoreColumns(scope.aspect);
	const query = joinAspect(
		db
			.select({
				observationId: sentimentObservations.id,
				promptRunId: sentimentObservations.promptRunId,
				promptId: promptRuns.promptId,
				runCreatedAt: promptRuns.createdAt,
				score,
			})
			.from(sentimentObservations)
			.innerJoin(sentimentAnalyses, withAnalysis)
			.$dynamic(),
		scope.aspect,
	)
		.innerJoin(promptRuns, eq(promptRuns.id, sentimentObservations.promptRunId))
		.where(
			and(
				completedObservationsWhere(scope.aspect, sqlScope),
				eq(sentimentObservations.brandId, scope.brandId),
				eq(sentimentObservations.entityKey, scope.entityKey),
			),
		)
		.orderBy(
			desc(score),
			desc(promptRuns.createdAt),
			desc(promptRuns.promptId),
			desc(sentimentObservations.promptRunId),
			desc(sentimentObservations.id),
		)
		.limit(scope.limit);
	const result = await db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (ANALYZE, BUFFERS) ${query.getSQL()}`);
	return result.rows.map((row) => row["QUERY PLAN"]);
}

/** The runs' own citations, deduplicated by URL and capped per run, in citation order. */
async function loadRunSources(runIds: string[]) {
	if (runIds.length === 0) return new Map<string, { url: string; domain: string; title: string | null }[]>();
	const ranked = db.$with("ranked").as(
		db
			.selectDistinctOn([citations.promptRunId, citations.url], {
				promptRunId: citations.promptRunId,
				url: citations.url,
				domain: citations.domain,
				title: citations.title,
				citationIndex: citations.citationIndex,
			})
			.from(citations)
			.where(inArray(citations.promptRunId, runIds))
			.orderBy(citations.promptRunId, citations.url, citations.citationIndex),
	);
	const rows = await db
		.with(ranked)
		.select({
			promptRunId: ranked.promptRunId,
			url: ranked.url,
			domain: ranked.domain,
			title: ranked.title,
			rank: sql<number>`row_number() over (partition by ${ranked.promptRunId} order by ${ranked.citationIndex}, ${ranked.url})::int`,
		})
		.from(ranked)
		.orderBy(ranked.promptRunId, ranked.citationIndex);
	const byRun = new Map<string, { url: string; domain: string; title: string | null }[]>();
	for (const row of rows) {
		if (row.rank > EVIDENCE_SOURCES_PER_RUN) continue;
		byRun.set(row.promptRunId, [
			...(byRun.get(row.promptRunId) ?? []),
			{ url: row.url, domain: row.domain, title: row.title },
		]);
	}
	return byRun;
}

export async function loadSentimentEvidence(scope: SentimentEvidenceScope): Promise<SentimentEvidenceResponse> {
	const { timezone, fromDate, toDate } = await resolveSentimentRange(scope.brandId, scope.lookback, scope.timezone);
	const promptIds = await resolveTaggedPromptIds(scope.brandId, scope.tags);
	const sqlScope = scopeRuns(scope.brandId, fromDate, toDate, timezone, promptIds);

	const entityName =
		scope.entityKey === BRAND_ENTITY_KEY
			? (await db.select({ name: brands.name }).from(brands).where(eq(brands.id, scope.brandId)).limit(1))[0]?.name
			: (
					await db
						.select({ name: competitors.name })
						.from(competitors)
						.where(and(eq(competitors.id, scope.entityKey), eq(competitors.brandId, scope.brandId)))
						.limit(1)
				)[0]?.name;
	if (!entityName) throw new Error("Entity not found");

	const { total, highest, lowest } = await loadExtremes(scope, sqlScope);
	const picked = [...highest, ...lowest];
	if (picked.length === 0)
		return {
			entity: { key: scope.entityKey, name: entityName },
			aspect: scope.aspect,
			totalObservations: total,
			highest: [],
			lowest: [],
		};

	const observationIds = picked.map((row) => row.observationId);
	const runIds = [...new Set(picked.map((row) => row.promptRunId))];
	const [observations, aspectRows, runs, sourcesByRun] = await Promise.all([
		db
			.select({
				id: sentimentObservations.id,
				promptRunId: sentimentObservations.promptRunId,
				score: sentimentObservations.score,
				category: sentimentObservations.category,
				evidence: sentimentObservations.evidence,
			})
			.from(sentimentObservations)
			.where(inArray(sentimentObservations.id, observationIds)),
		db
			.select({
				observationId: sentimentAspectObservations.observationId,
				key: sentimentAspectObservations.aspectKey,
				label: sentimentAspectObservations.aspectLabel,
				score: sentimentAspectObservations.score,
				category: sentimentAspectObservations.category,
				evidence: sentimentAspectObservations.evidence,
			})
			.from(sentimentAspectObservations)
			.where(
				and(
					inArray(sentimentAspectObservations.observationId, observationIds),
					eq(sentimentAspectObservations.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
				),
			),
		db
			.select({
				id: promptRuns.id,
				promptId: promptRuns.promptId,
				createdAt: promptRuns.createdAt,
				rawOutput: promptRuns.rawOutput,
				provider: promptRuns.provider,
				model: promptRuns.model,
				promptText: prompts.value,
				tags: prompts.tags,
			})
			.from(promptRuns)
			.innerJoin(prompts, eq(prompts.id, promptRuns.promptId))
			.where(inArray(promptRuns.id, runIds)),
		loadRunSources(runIds),
	]);
	const observationById = new Map(observations.map((row) => [row.id, row]));
	const aspectsByObservation = new Map<string, typeof aspectRows>();
	for (const row of aspectRows)
		aspectsByObservation.set(row.observationId, [...(aspectsByObservation.get(row.observationId) ?? []), row]);
	const runById = new Map(runs.map((row) => [row.id, row]));

	const toItem = (candidate: ExtremeRow): SentimentEvidenceItem | null => {
		const observation = observationById.get(candidate.observationId);
		const run = runById.get(candidate.promptRunId);
		if (!observation || !run) return null;
		const aspects = (aspectsByObservation.get(observation.id) ?? []).map((row) => ({
			key: row.key as SentimentAspectKey,
			label: row.label,
			score: row.score,
			category: row.category as SentimentCategory,
		}));
		const selectedAspect =
			scope.aspect === "overall"
				? null
				: (aspectsByObservation.get(observation.id) ?? []).find((row) => row.key === scope.aspect);
		const evidence =
			(selectedAspect
				? (selectedAspect.evidence as SentimentEvidence[])
				: (observation.evidence as SentimentEvidence[])) ?? [];
		const body = extractAnswerBody(run.rawOutput, run.provider, run.model) ?? "";
		return {
			observationId: observation.id,
			promptRunId: run.id,
			promptId: run.promptId,
			promptText: run.promptText,
			tags: run.tags ?? [],
			runCreatedAt: run.createdAt.toISOString(),
			score: candidate.score,
			category: (selectedAspect ? selectedAspect.category : observation.category) as SentimentCategory,
			evidence,
			...excerptAround(body, evidence),
			aspects,
			sources: sourcesByRun.get(run.id) ?? [],
		};
	};
	return {
		entity: { key: scope.entityKey, name: entityName },
		aspect: scope.aspect,
		totalObservations: total,
		highest: highest.map(toItem).filter((item): item is SentimentEvidenceItem => item !== null),
		lowest: lowest.map(toItem).filter((item): item is SentimentEvidenceItem => item !== null),
	};
}
