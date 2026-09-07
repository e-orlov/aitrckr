/**
 * Pure, dependency-free Competitive AI Visibility: the brand and every tracked
 * competitor measured with the one Visibility definition the Overview and the
 * Visibility page already share — per-prompt Last-Value-Carried-Forward runs,
 * summed per day, mentioned ÷ runs, rounded once at display time.
 *
 * Visibility is NOT Share of Voice. Every entity is divided by the same
 * denominator (all carried eligible runs of the day), a run may count for the
 * brand and for several competitors at once, and the percentages are
 * independent — they may sum to more or less than 100. There is no "Others"
 * series: summing tail competitors would not be the Visibility of anything.
 */

import { compareMentionsDescThenName } from "@/lib/visibility-stats";

export const COMPETITIVE_VISIBILITY_TREND_TOP_N = 6;

/** Runs of one prompt on one day and how many of them mentioned the brand. */
export interface PromptDayRuns {
	promptId: string;
	date: string;
	runs: number;
	brandRuns: number;
}

/** Runs of one prompt on one day that mentioned a competitor (each run counted once per competitor). */
export interface PromptDayCompetitorRuns {
	promptId: string;
	date: string;
	competitor: string;
	runs: number;
}

export interface CompetitiveEntityInput {
	id: string;
	name: string;
}

export interface CompetitiveVisibilityEntity {
	/** Stable series key: `brand` for the own brand, the competitor id otherwise. */
	key: string;
	id: string;
	name: string;
	isBrand: boolean;
	/** Carried eligible runs at `asOfDate` that mention this entity. */
	mentionedRuns: number;
	/** Exact `mentionedRuns / snapshotRuns × 100`; null when there is no denominator. Round once at display time. */
	visibility: number | null;
	/** Evaluated prompts whose carried observation at `asOfDate` mentions this entity. */
	visiblePromptCount: number;
	/** Exact `visiblePromptCount / evaluatedPromptCount × 100`; null when no prompt was evaluated. */
	coveragePercent: number | null;
	/** 1-based position in the leaderboard order. */
	rank: number;
}

export interface CompetitiveVisibilitySeries {
	key: string;
	id: string;
	name: string;
	isBrand: boolean;
}

export interface CompetitiveVisibilityPoint {
	date: string;
	/** Carried eligible runs of the day — the shared denominator; null when no prompt has an observation yet. */
	runs: number | null;
	/** Carried runs mentioning each series entity, by series key. */
	mentioned: Record<string, number>;
	/** Exact percentage per series key; null when `runs` is null or 0. */
	visibility: Record<string, number | null>;
}

export interface CompetitiveVisibilityResult {
	/** Day the current values describe: the last day of the range with carried runs; null when there is no data. */
	asOfDate: string | null;
	/** Denominator of every current value. */
	snapshotRuns: number;
	/** Distinct prompts with at least one eligible observation in the range — the same set for every entity. */
	evaluatedPromptCount: number;
	/** Whole-range actual observations (not carried). Informational; never a denominator of the current values. */
	windowRuns: number;
	/** Brand plus every tracked competitor, in leaderboard order. */
	entities: CompetitiveVisibilityEntity[];
	/** Brand first, then the top competitors in rank order — the roster the radial and the trend draw. */
	series: CompetitiveVisibilitySeries[];
	points: CompetitiveVisibilityPoint[];
}

export const BRAND_SERIES_KEY = "brand";

interface Observation {
	runs: number;
	brandRuns: number;
	competitorRuns: Map<string, number>;
}

const asCount = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
const byDateAsc = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Group the two row shapes into one {runs, brandRuns, competitorRuns} observation per prompt and day. */
function groupObservations(
	promptRuns: PromptDayRuns[],
	competitorRuns: PromptDayCompetitorRuns[],
): Map<string, Map<string, Observation>> {
	const byPrompt = new Map<string, Map<string, Observation>>();
	const observationAt = (promptId: string, date: string): Observation => {
		const dateMap = byPrompt.get(promptId) ?? new Map<string, Observation>();
		byPrompt.set(promptId, dateMap);
		const observation = dateMap.get(date) ?? { runs: 0, brandRuns: 0, competitorRuns: new Map() };
		dateMap.set(date, observation);
		return observation;
	};
	for (const row of promptRuns) {
		const runs = asCount(row.runs);
		if (runs === 0) continue;
		const observation = observationAt(row.promptId, row.date);
		observation.runs = runs;
		observation.brandRuns = Math.min(runs, asCount(row.brandRuns));
	}
	for (const row of competitorRuns) {
		const runs = asCount(row.runs);
		if (runs === 0) continue;
		const observation = byPrompt.get(row.promptId)?.get(row.date);
		// A competitor row without a matching run row is not an eligible observation.
		if (!observation) continue;
		observation.competitorRuns.set(row.competitor, Math.min(observation.runs, runs));
	}
	return byPrompt;
}

interface CarriedDay {
	runs: number;
	brandRuns: number;
	competitorRuns: Map<string, number>;
	/** Prompts contributing to this day, with their carried observation. */
	prompts: Map<string, Observation>;
}

/**
 * Sum every prompt's carried observation per day. Each prompt is seeded with
 * its earliest observation and advanced to its latest observation on or before
 * the day — the whole {runs, brand, competitors} observation at once, so a run
 * that stops naming a competitor drops it. Same carry as the canonical
 * visibility aggregate; competitors ride along on the same snapshot.
 */
function carriedByDay(byPrompt: Map<string, Map<string, Observation>>, dateRange: string[]): Map<string, CarriedDay> {
	const days = new Map<string, CarriedDay>();
	for (const [promptId, dateMap] of byPrompt) {
		const observations = [...dateMap.entries()].sort(byDateAsc);
		if (observations.length === 0) continue;
		let next = 0;
		let carried = observations[0][1];
		for (const date of dateRange) {
			while (next < observations.length && observations[next][0] <= date) carried = observations[next++][1];
			let day = days.get(date);
			if (!day) {
				day = { runs: 0, brandRuns: 0, competitorRuns: new Map(), prompts: new Map() };
				days.set(date, day);
			}
			day.runs += carried.runs;
			day.brandRuns += carried.brandRuns;
			for (const [name, runs] of carried.competitorRuns) {
				day.competitorRuns.set(name, (day.competitorRuns.get(name) ?? 0) + runs);
			}
			day.prompts.set(promptId, carried);
		}
	}
	return days;
}

const percent = (numerator: number, denominator: number): number | null =>
	denominator === 0 ? null : (numerator / denominator) * 100;

/**
 * Leaderboard order: Visibility descending (== mentioned runs descending, the
 * denominator being shared), then name by code unit, then id — deterministic
 * for equal counts on every host and row order. The brand is not pinned.
 */
export function compareEntities(
	a: { name: string; mentions: number; id: string },
	b: { name: string; mentions: number; id: string },
): number {
	return compareMentionsDescThenName(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Competitive Visibility for one resolved scope.
 *
 * @param brand       the own brand (name is the label; observations carry `brandRuns`).
 * @param competitors every tracked competitor. Observations are matched by the
 *                    competitor's current `name` — the only link `prompt_runs.competitors_mentioned`
 *                    offers — so a competitor renamed after its runs loses that history.
 * @param promptRuns  runs and brand-mentioning runs per prompt and day.
 * @param competitorRuns runs mentioning each competitor per prompt and day (one count per run).
 * @param dateRange   every day of the window, ascending.
 */
export function computeCompetitiveVisibility(
	brand: CompetitiveEntityInput,
	competitors: CompetitiveEntityInput[],
	promptRuns: PromptDayRuns[],
	competitorRuns: PromptDayCompetitorRuns[],
	dateRange: string[],
	topN = COMPETITIVE_VISIBILITY_TREND_TOP_N,
): CompetitiveVisibilityResult {
	const empty: CompetitiveVisibilityResult = {
		asOfDate: null,
		snapshotRuns: 0,
		evaluatedPromptCount: 0,
		windowRuns: 0,
		entities: [],
		series: [],
		points: [],
	};
	if (dateRange.length === 0) return empty;
	// Competitor ids double as series keys, so none may spell the brand's key.
	if (competitors.some((c) => c.id === BRAND_SERIES_KEY)) {
		throw new Error(`Competitor id "${BRAND_SERIES_KEY}" collides with the brand series key`);
	}

	const byPrompt = groupObservations(promptRuns, competitorRuns);
	let windowRuns = 0;
	for (const dateMap of byPrompt.values()) {
		for (const [date, observation] of dateMap) {
			if (date >= dateRange[0] && date <= dateRange[dateRange.length - 1]) windowRuns += observation.runs;
		}
	}
	const days = carriedByDay(byPrompt, dateRange);

	// Current = the last day with a denominator (the last non-null trend point).
	let asOfDate: string | null = null;
	for (let i = dateRange.length - 1; i >= 0; i--) {
		if ((days.get(dateRange[i])?.runs ?? 0) > 0) {
			asOfDate = dateRange[i];
			break;
		}
	}
	const snapshot = asOfDate ? (days.get(asOfDate) as CarriedDay) : null;
	const snapshotRuns = snapshot?.runs ?? 0;
	const evaluatedPromptCount = snapshot?.prompts.size ?? 0;

	const candidates = [
		{
			key: BRAND_SERIES_KEY,
			id: brand.id,
			name: brand.name,
			isBrand: true,
			mentions: snapshot?.brandRuns ?? 0,
			visiblePrompts: snapshot ? [...snapshot.prompts.values()].filter((o) => o.brandRuns > 0).length : 0,
		},
		...competitors.map((c) => ({
			key: c.id,
			id: c.id,
			name: c.name,
			isBrand: false,
			mentions: snapshot?.competitorRuns.get(c.name) ?? 0,
			visiblePrompts: snapshot
				? [...snapshot.prompts.values()].filter((o) => (o.competitorRuns.get(c.name) ?? 0) > 0).length
				: 0,
		})),
	].sort(compareEntities);

	const entities: CompetitiveVisibilityEntity[] = candidates.map((c, i) => ({
		key: c.key,
		id: c.id,
		name: c.name,
		isBrand: c.isBrand,
		mentionedRuns: c.mentions,
		visibility: percent(c.mentions, snapshotRuns),
		visiblePromptCount: c.visiblePrompts,
		coveragePercent: percent(c.visiblePrompts, evaluatedPromptCount),
		rank: i + 1,
	}));

	// The brand always has a line and never takes a competitor slot; competitors
	// keep leaderboard order, so the roster is frozen for the whole axis.
	const series: CompetitiveVisibilitySeries[] = [
		{ key: BRAND_SERIES_KEY, id: brand.id, name: brand.name, isBrand: true },
		...candidates
			.filter((c) => !c.isBrand)
			.slice(0, topN)
			.map((c) => ({ key: c.key, id: c.id, name: c.name, isBrand: false })),
	];
	const seriesNameByKey = new Map(series.map((s) => [s.key, s.name]));

	const points: CompetitiveVisibilityPoint[] = dateRange.map((date) => {
		const day = days.get(date);
		const mentioned: Record<string, number> = {};
		const visibility: Record<string, number | null> = {};
		for (const s of series) {
			const count = !day
				? 0
				: s.isBrand
					? day.brandRuns
					: (day.competitorRuns.get(seriesNameByKey.get(s.key) as string) ?? 0);
			mentioned[s.key] = count;
			visibility[s.key] = day ? percent(count, day.runs) : null;
		}
		return { date, runs: day ? day.runs : null, mentioned, visibility };
	});

	return { asOfDate, snapshotRuns, evaluatedPromptCount, windowRuns, entities, series, points };
}
