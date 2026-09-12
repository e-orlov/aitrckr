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
	sentimentObservations,
} from "@workspace/lib/db/schema";
import { extractAnswerBody } from "@workspace/lib/sentiment";
import {
	bucketForRange,
	computeEntityMetrics,
	type EntityMetrics,
	LOW_SAMPLE_THRESHOLD,
	type SentimentBucket,
	selectChartRoster,
	splitExtremes,
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
import { and, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
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

export interface SentimentEntityRow {
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	name: string;
	isBrand: boolean;
	/** Distinct responses mentioning the entity (`M`). */
	mentions: number;
	/** Mentions classified at the current version for the selected aspect (`C`). */
	classified: number;
	counts: { positive: number; neutral: number; mixed: number; negative: number };
	metrics: EntityMetrics;
	lowSample: boolean;
}

export interface SentimentSeriesPoint {
	bucketStart: string;
	values: Record<string, { sentiment: number | null; classified: number }>;
}

export interface SentimentOverviewResponse {
	brand: { id: string; name: string };
	dateRange: { fromDate: string; toDate: string; timezone: string };
	aspect: SentimentAspectFilter;
	availableAspects: { key: SentimentAspectKey; label: string; count: number }[];
	/** Eligible stored responses in scope (`T`). */
	eligibleResponses: number;
	coverage: {
		/** Responses in scope the detector has visited (any mention row, any version). */
		responsesDetected: number;
		/** Responses in scope with at least one current-version mention. */
		responsesWithMentions: number;
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
	evidence: SentimentEvidence[];
	/** A short window of the stored answer around the first excerpt. */
	excerpt: string;
	aspects: { key: SentimentAspectKey; label: string; score: number; category: SentimentCategory }[];
	/** The monitoring answer's own citations — never classifier search results. */
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

function completedObservationsWhere(aspect: SentimentAspectFilter, scope: ScopeSql): SQL {
	const base = and(
		eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
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

function observationQuery(aspect: SentimentAspectFilter) {
	const base = db
		.select({
			entityKey: sentimentObservations.entityKey,
			promptRunId: sentimentObservations.promptRunId,
			observationId: sentimentObservations.id,
			...scoreColumns(aspect),
		})
		.from(sentimentObservations)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentObservations.analysisId));
	return aspect === "overall"
		? base
		: base.innerJoin(
				sentimentAspectObservations,
				eq(sentimentAspectObservations.observationId, sentimentObservations.id),
			);
}

interface AggRow {
	entityKey: string;
	classified: number;
	scoreSum: number;
	positive: number;
	neutral: number;
	mixed: number;
	negative: number;
}

async function aggregateByEntity(aspect: SentimentAspectFilter, scope: ScopeSql): Promise<Map<string, AggRow>> {
	const { score, category } = scoreColumns(aspect);
	const base = db
		.select({
			entityKey: sentimentObservations.entityKey,
			classified: sql<number>`count(*)::int`,
			scoreSum: sql<number>`coalesce(sum(${score}), 0)::int`,
			positive: sql<number>`count(*) filter (where ${category} = 'positive')::int`,
			neutral: sql<number>`count(*) filter (where ${category} = 'neutral')::int`,
			mixed: sql<number>`count(*) filter (where ${category} = 'mixed')::int`,
			negative: sql<number>`count(*) filter (where ${category} = 'negative')::int`,
		})
		.from(sentimentObservations)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentObservations.analysisId));
	const joined =
		aspect === "overall"
			? base
			: base.innerJoin(
					sentimentAspectObservations,
					eq(sentimentAspectObservations.observationId, sentimentObservations.id),
				);
	const rows = await joined.where(completedObservationsWhere(aspect, scope)).groupBy(sentimentObservations.entityKey);
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
	const [[detected], [withMentions], statuses] = await Promise.all([
		db
			.select({ value: sql<number>`count(distinct ${promptRunEntityMentions.promptRunId})::int` })
			.from(promptRunEntityMentions)
			.where(inArray(promptRunEntityMentions.promptRunId, runIdsInScope(scope))),
		db
			.select({ value: sql<number>`count(distinct ${promptRunEntityMentions.promptRunId})::int` })
			.from(promptRunEntityMentions)
			.where(
				and(
					eq(promptRunEntityMentions.detectorVersion, SENTIMENT_DETECTOR_VERSION),
					inArray(promptRunEntityMentions.promptRunId, runIdsInScope(scope)),
				),
			),
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
	const byStatus = new Map(statuses.map((row) => [row.status, row.value]));
	return {
		responsesDetected: detected?.value ?? 0,
		responsesWithMentions: withMentions?.value ?? 0,
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
	const base = db
		.select({
			entityKey: sentimentObservations.entityKey,
			bucketStart: bucketExpr.as("bucket_start"),
			classified: sql<number>`count(*)::int`,
			scoreSum: sql<number>`coalesce(sum(${score}), 0)::int`,
		})
		.from(sentimentObservations)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentObservations.analysisId))
		.innerJoin(promptRuns, eq(promptRuns.id, sentimentObservations.promptRunId));
	const joined =
		aspect === "overall"
			? base
			: base.innerJoin(
					sentimentAspectObservations,
					eq(sentimentAspectObservations.observationId, sentimentObservations.id),
				);
	const rows = await joined
		.where(and(completedObservationsWhere(aspect, scope), inArray(sentimentObservations.entityKey, roster)))
		// Ordinal grouping: the bucket expression binds the timezone as a parameter,
		// and Postgres would not match a second copy of it in GROUP BY.
		.groupBy(sql`1`, sql`2`);
	const byBucket = new Map<string, Map<string, { sentiment: number | null; classified: number }>>();
	for (const row of rows) {
		const entry = byBucket.get(row.bucketStart) ?? new Map();
		entry.set(row.entityKey, {
			sentiment: row.classified === 0 ? null : row.scoreSum / row.classified,
			classified: row.classified,
		});
		byBucket.set(row.bucketStart, entry);
	}
	return buckets.map((bucketStart) => {
		const values: SentimentSeriesPoint["values"] = {};
		const entry = byBucket.get(bucketStart);
		for (const key of roster) values[key] = entry?.get(key) ?? { sentiment: null, classified: 0 };
		return { bucketStart, values };
	});
}

export async function loadSentimentOverview(scope: SentimentScope): Promise<SentimentOverviewResponse> {
	const { timezone, fromDate, toDate } = await resolveSentimentRange(scope.brandId, scope.lookback, scope.timezone);
	const promptIds = await resolveTaggedPromptIds(scope.brandId, scope.tags);
	const sqlScope = scopeRuns(scope.brandId, fromDate, toDate, timezone, promptIds);

	const [brandRows, roster, [eligible], mentions, aggregates, coverage, aspects] = await Promise.all([
		db.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.id, scope.brandId)).limit(1),
		db
			.select({ id: competitors.id, name: competitors.name })
			.from(competitors)
			.where(activeCompetitorsOf(scope.brandId))
			.orderBy(competitors.createdAt, competitors.id),
		db.select({ value: sql<number>`count(*)::int` }).from(promptRuns).where(sqlScope.runsWhere),
		mentionsByEntity(sqlScope),
		aggregateByEntity(scope.aspect, sqlScope),
		coverageStats(sqlScope),
		availableAspects(sqlScope),
	]);
	const brand = brandRows[0];
	if (!brand) throw new Error("Brand not found");
	const eligibleResponses = eligible?.value ?? 0;

	const toRow = (
		key: string,
		entityType: "brand" | "competitor",
		competitorId: string | null,
		name: string,
	): SentimentEntityRow => {
		const agg = aggregates.get(key);
		const mentionCount = mentions.get(key) ?? 0;
		const counts = {
			positive: agg?.positive ?? 0,
			neutral: agg?.neutral ?? 0,
			mixed: agg?.mixed ?? 0,
			negative: agg?.negative ?? 0,
		};
		const classified = agg?.classified ?? 0;
		return {
			key,
			entityType,
			competitorId,
			name,
			isBrand: entityType === "brand",
			mentions: mentionCount,
			classified,
			counts,
			metrics: computeEntityMetrics({
				eligibleResponses,
				mentions: mentionCount,
				classified,
				...counts,
				scoreSum: agg?.scoreSum ?? 0,
			}),
			lowSample: classified > 0 && classified < LOW_SAMPLE_THRESHOLD,
		};
	};
	const brandRow = toRow(BRAND_ENTITY_KEY, "brand", null, brand.name);
	const competitorRows = roster.map((c) => toRow(c.id, "competitor", c.id, c.name));
	const chartRoster = [BRAND_ENTITY_KEY, ...selectChartRoster(competitorRows, 6).map((row) => row.key)];

	const bucket = bucketForRange(daysBetween(fromDate, toDate));
	const buckets = enumerateBuckets(fromDate, toDate, bucket);
	const series = await seriesByBucket(scope.aspect, sqlScope, bucket, chartRoster, buckets);

	return {
		brand,
		dateRange: { fromDate, toDate, timezone },
		aspect: scope.aspect,
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

function excerptAround(answer: string, evidence: SentimentEvidence[]): string {
	const first = evidence[0];
	if (!first) return answer.slice(0, EXCERPT_RADIUS * 2);
	const at = answer.toLowerCase().indexOf(first.quote.toLowerCase());
	if (at === -1) return answer.slice(0, EXCERPT_RADIUS * 2);
	const start = Math.max(0, at - EXCERPT_RADIUS);
	const end = Math.min(answer.length, at + first.quote.length + EXCERPT_RADIUS);
	return `${start > 0 ? "…" : ""}${answer.slice(start, end)}${end < answer.length ? "…" : ""}`;
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

	const scored = await observationQuery(scope.aspect)
		.innerJoin(promptRuns, eq(promptRuns.id, sentimentObservations.promptRunId))
		.where(
			and(completedObservationsWhere(scope.aspect, sqlScope), eq(sentimentObservations.entityKey, scope.entityKey)),
		);
	const runMeta = new Map(
		(
			await db
				.select({ id: promptRuns.id, createdAt: promptRuns.createdAt, promptId: promptRuns.promptId })
				.from(promptRuns)
				.where(
					inArray(
						promptRuns.id,
						scored.map((row) => row.promptRunId),
					),
				)
		).map((row) => [row.id, row]),
	);
	const candidates = scored.map((row) => ({
		observationId: row.observationId,
		promptRunId: row.promptRunId,
		score: row.score,
		runCreatedAt: runMeta.get(row.promptRunId)?.createdAt.toISOString() ?? "",
		promptId: runMeta.get(row.promptRunId)?.promptId ?? "",
	}));
	const { highest, lowest } = splitExtremes(candidates, scope.limit);
	const picked = [...highest, ...lowest];
	if (picked.length === 0)
		return {
			entity: { key: scope.entityKey, name: entityName },
			aspect: scope.aspect,
			totalObservations: 0,
			highest: [],
			lowest: [],
		};

	const observationIds = picked.map((row) => row.observationId);
	const runIds = [...new Set(picked.map((row) => row.promptRunId))];
	const [observations, aspectRows, runs, sources] = await Promise.all([
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
		db
			.select({
				promptRunId: citations.promptRunId,
				url: citations.url,
				domain: citations.domain,
				title: citations.title,
				index: citations.citationIndex,
			})
			.from(citations)
			.where(inArray(citations.promptRunId, runIds))
			.orderBy(citations.citationIndex),
	]);
	const observationById = new Map(observations.map((row) => [row.id, row]));
	const aspectsByObservation = new Map<string, typeof aspectRows>();
	for (const row of aspectRows)
		aspectsByObservation.set(row.observationId, [...(aspectsByObservation.get(row.observationId) ?? []), row]);
	const runById = new Map(runs.map((row) => [row.id, row]));
	const sourcesByRun = new Map<string, { url: string; domain: string; title: string | null }[]>();
	for (const row of sources)
		sourcesByRun.set(row.promptRunId, [
			...(sourcesByRun.get(row.promptRunId) ?? []),
			{ url: row.url, domain: row.domain, title: row.title },
		]);

	const toItem = (candidate: (typeof picked)[number]): SentimentEvidenceItem | null => {
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
			excerpt: excerptAround(body, evidence),
			aspects,
			sources: sourcesByRun.get(run.id) ?? [],
		};
	};
	return {
		entity: { key: scope.entityKey, name: entityName },
		aspect: scope.aspect,
		totalObservations: candidates.length,
		highest: highest.map(toItem).filter((item): item is SentimentEvidenceItem => item !== null),
		lowest: lowest.map(toItem).filter((item): item is SentimentEvidenceItem => item !== null),
	};
}
