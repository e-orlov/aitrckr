/**
 * Pure, dependency-free statistics for AI-visibility analysis.
 *
 * These power the Share of Voice page and the Opportunities digest's stability
 * scores. They take plain aggregated rows (produced by the
 * postgres read layer) and never touch IO, so they are unit-testable in
 * isolation.
 *
 * Two notions of "how much do the cited sources move over time" live here and
 * are deliberately kept distinct — in practice they are near-orthogonal:
 *   - set volatility:      churn in the *set* of cited domains (Jaccard distance).
 *   - weighted volatility: churn weighted by citation *volume* (Bray–Curtis on
 *     the daily citation-share vectors). A prompt with one dominant source every
 *     day but a noisy long tail looks volatile by set yet stable by volume —
 *     weighted is the truer "do the sources that carry the answer move?" signal,
 *     so it's the one we surface as the Stability score.
 */

export interface DailyDomainCount {
	/** ISO day bucket, "YYYY-MM-DD" (lexicographically sortable = chronological). */
	date: string;
	domain: string;
	/** Number of citations to `domain` on `date`. */
	count: number;
}

export interface VolatilityResult {
	/** Mean Jaccard distance between consecutive days' domain sets, 0..1. null if < 2 days of data. */
	setVolatility: number | null;
	/** Mean Bray–Curtis distance between consecutive days' citation-share vectors, 0..1. null if < 2 days. */
	weightedVolatility: number | null;
	/** Consecutive-day transitions the averages are based on. Use as a reliability gate. */
	dayTransitions: number;
}

interface DayBucket {
	date: string;
	counts: Map<string, number>;
	total: number;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Collapse raw rows into one bucket per day (summing duplicate domains), sorted chronologically. */
function bucketByDay(daily: DailyDomainCount[]): DayBucket[] {
	const byDate = new Map<string, Map<string, number>>();
	for (const { date, domain, count } of daily) {
		if (count <= 0) continue;
		let m = byDate.get(date);
		if (!m) {
			m = new Map();
			byDate.set(date, m);
		}
		m.set(domain, (m.get(domain) ?? 0) + count);
	}
	return [...byDate.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([date, counts]) => {
			let total = 0;
			for (const c of counts.values()) total += c;
			return { date, counts, total };
		});
}

/**
 * Citation volatility: how much the cited-domain set churns from one day to the next.
 * Returns both the unweighted (set) and volume-weighted distances, averaged over
 * every consecutive-day transition.
 */
export function computeVolatility(daily: DailyDomainCount[]): VolatilityResult {
	const days = bucketByDay(daily);
	if (days.length < 2) {
		return { setVolatility: null, weightedVolatility: null, dayTransitions: 0 };
	}

	let setSum = 0;
	let weightedSum = 0;
	let transitions = 0;

	for (let i = 1; i < days.length; i++) {
		const prev = days[i - 1];
		const cur = days[i];

		// Jaccard distance on the domain sets: 1 - |A∩B| / |A∪B|.
		let inter = 0;
		for (const d of cur.counts.keys()) {
			if (prev.counts.has(d)) inter++;
		}
		const union = cur.counts.size + prev.counts.size - inter;
		const setDist = union === 0 ? 0 : 1 - inter / union;

		// Bray–Curtis distance on the citation-share vectors: 1 - Σ min(shareCur, sharePrev).
		// Domains present on only one of the two days contribute min(x, 0) = 0, so we only
		// need to walk the shared domains.
		let overlap = 0;
		for (const [d, c] of cur.counts) {
			const prevC = prev.counts.get(d);
			if (prevC === undefined) continue;
			overlap += Math.min(c / cur.total, prevC / prev.total);
		}
		const weightedDist = 1 - overlap;

		setSum += setDist;
		weightedSum += weightedDist;
		transitions++;
	}

	return {
		setVolatility: round3(setSum / transitions),
		weightedVolatility: round3(weightedSum / transitions),
		dayTransitions: transitions,
	};
}

/** Product-facing Stability score: 0 (churns daily) → 100 (rock stable). null if not enough data. */
export function stabilityScore(weightedVolatility: number | null): number | null {
	if (weightedVolatility === null) return null;
	return Math.round((1 - clamp01(weightedVolatility)) * 100);
}

/**
 * Ranking order shared by the leaderboard, donut, colour map and the comparison
 * trend: mentions descending, then the name by code unit so equal counts land
 * in the same order on every host and for every database row order (a
 * locale-aware compare would not).
 */
export function compareMentionsDescThenName(a: { name: string; mentions: number }, b: { name: string; mentions: number }) {
	if (a.mentions !== b.mentions) return b.mentions - a.mentions;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface VoiceShare {
	name: string;
	/** Run-days (or runs) on which this entity was mentioned. */
	mentions: number;
	/** Share of total mentions across the brand + all competitors, 0..1. Exact
	 * ratio (not pre-rounded) — round once at the display layer so the table,
	 * donut, and trend never disagree by a point. */
	share: number;
	isBrand: boolean;
}

/**
 * Share of voice across the brand and its competitors. Inputs must be in a
 * consistent unit (e.g. "# of runs that mentioned this entity"), so the brand's
 * mention count and each competitor's are directly comparable.
 *
 * `share`/`brandShare` are exact ratios, deliberately NOT pre-rounded: the
 * leaderboard renders `round(share * 100)`, the donut `round(mentions / total *
 * 100)`, and the trend `round(brand / denom * 100)` — all the same single round
 * of the same ratio. Pre-rounding `share` here (e.g. to 3 decimals) would
 * double-round and let the table read a point off the headline/donut.
 */
export function computeShareOfVoice(
	brand: { name: string; mentions: number },
	competitors: { name: string; mentions: number }[],
): { entries: VoiceShare[]; brandShare: number | null; total: number } {
	let total = brand.mentions;
	for (const c of competitors) total += c.mentions;
	const mk = (name: string, mentions: number, isBrand: boolean): VoiceShare => ({
		name,
		mentions,
		isBrand,
		share: total === 0 ? 0 : mentions / total,
	});
	// The brand keeps its place ahead of a competitor with the same count.
	const entries = [mk(brand.name, brand.mentions, true), ...competitors.map((c) => mk(c.name, c.mentions, false))].sort(
		(a, b) => {
			if (a.mentions !== b.mentions) return b.mentions - a.mentions;
			if (a.isBrand !== b.isBrand) return a.isBrand ? -1 : 1;
			return compareMentionsDescThenName(a, b);
		},
	);
	return { entries, brandShare: total === 0 ? null : brand.mentions / total, total };
}

export interface PerPromptDailyMentions {
	promptId: string;
	date: string;
	brandMentions: number;
	competitorMentions: number;
}

/**
 * Brand share of voice over time, smoothed with per-prompt Last-Value-Carried-
 * Forward (mirrors the visibility trend): each prompt's last-known brand and
 * competitor mention counts are carried across days it didn't run, then summed
 * per day, so staggered prompt schedules do not create artificial dips. The carry is
 * pre-seeded with each prompt's earliest observation to avoid a ramp-up dip.
 * Share = brand / (brand + competitor), as a 0–100 percentage (null = no data).
 */
export function shareOfVoiceTimeSeriesLVCF(
	perPrompt: PerPromptDailyMentions[],
	dateRange: string[],
): Array<{ date: string; share: number | null }> {
	const byPrompt = new Map<string, Map<string, { brand: number; competitor: number }>>();
	for (const r of perPrompt) {
		let m = byPrompt.get(r.promptId);
		if (!m) {
			m = new Map();
			byPrompt.set(r.promptId, m);
		}
		m.set(r.date, { brand: r.brandMentions, competitor: r.competitorMentions });
	}

	const daily = new Map<string, { brand: number; competitor: number }>();
	for (const [, dateMap] of byPrompt) {
		const sorted = [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b));
		let carried = sorted.length > 0 ? sorted[0][1] : null;
		for (const date of dateRange) {
			const actual = dateMap.get(date);
			if (actual) carried = actual;
			if (!carried) continue;
			let bucket = daily.get(date);
			if (!bucket) {
				bucket = { brand: 0, competitor: 0 };
				daily.set(date, bucket);
			}
			bucket.brand += carried.brand;
			bucket.competitor += carried.competitor;
		}
	}

	return dateRange.map((date) => {
		const b = daily.get(date);
		if (!b) return { date, share: null };
		const denom = b.brand + b.competitor;
		return { date, share: denom === 0 ? null : Math.round((b.brand / denom) * 100) };
	});
}

export interface LeaderboardLVCFResult {
	brandMentions: number;
	brandPrompts: number;
	competitors: Array<{ name: string; mentions: number; prompts: number }>;
}

interface DailyObservation {
	brand: number;
	competitors: Map<string, number>;
}

function groupObservations(
	brandDaily: Array<{ promptId: string; date: string; brand: number }>,
	competitorDaily: Array<{ promptId: string; date: string; competitor: string; mentions: number }>,
): Map<string, Map<string, DailyObservation>> {
	const byPrompt = new Map<string, Map<string, DailyObservation>>();
	const observationAt = (promptId: string, date: string): DailyObservation => {
		const dateMap = byPrompt.get(promptId) ?? new Map<string, DailyObservation>();
		byPrompt.set(promptId, dateMap);
		const observation = dateMap.get(date) ?? { brand: 0, competitors: new Map() };
		dateMap.set(date, observation);
		return observation;
	};

	for (const row of brandDaily) observationAt(row.promptId, row.date).brand = row.brand;
	for (const row of competitorDaily) {
		if (row.mentions > 0) observationAt(row.promptId, row.date).competitors.set(row.competitor, row.mentions);
	}
	return byPrompt;
}

function latestObservation(dateMap: Map<string, DailyObservation>, lastDate: string): DailyObservation | null {
	let latest: DailyObservation | null = null;
	let latestDate = "";
	for (const [date, observation] of dateMap) {
		if (date > lastDate || date < latestDate) continue;
		latest = observation;
		latestDate = date;
	}
	return latest;
}

/**
 * "Current standings" leaderboard: carry each prompt's most recent (brand +
 * per-competitor) mention counts forward to the last day, then sum across
 * prompts. This is the per-competitor companion to shareOfVoiceTimeSeriesLVCF
 * and uses the same per-prompt last-observation carry-forward, so the brand
 * share it implies equals that trend's final point — keeping the headline,
 * donut, and table consistent with the line (rather than a whole-window
 * aggregate that wouldn't match it).
 */
export function shareOfVoiceLeaderboardLVCF(
	brandDaily: Array<{ promptId: string; date: string; brand: number }>,
	competitorDaily: Array<{ promptId: string; date: string; competitor: string; mentions: number }>,
	dateRange: string[],
): LeaderboardLVCFResult {
	if (dateRange.length === 0) return { brandMentions: 0, brandPrompts: 0, competitors: [] };
	const lastDate = dateRange[dateRange.length - 1];

	const byPrompt = groupObservations(brandDaily, competitorDaily);

	let brandMentions = 0;
	let brandPrompts = 0;
	const compMentions = new Map<string, number>();
	const compPrompts = new Map<string, number>();

	for (const [, dateMap] of byPrompt) {
		const last = latestObservation(dateMap, lastDate);
		if (!last) continue;
		brandMentions += last.brand;
		if (last.brand > 0) brandPrompts++;
		for (const [name, mentions] of last.competitors) {
			if (mentions <= 0) continue;
			compMentions.set(name, (compMentions.get(name) ?? 0) + mentions);
			compPrompts.set(name, (compPrompts.get(name) ?? 0) + 1);
		}
	}

	const competitors = [...compMentions.entries()]
		.map(([name, mentions]) => ({ name, mentions, prompts: compPrompts.get(name) ?? 0 }))
		.sort(compareMentionsDescThenName);

	return { brandMentions, brandPrompts, competitors };
}

export type ShareOfVoiceTrendSeriesKind = "brand" | "competitor" | "others";

export interface ShareOfVoiceTrendSeries {
	/** Internal, collision-safe key the points are addressed by: `brand`, `competitor-1`…, `others`. */
	key: string;
	/** Display label — the brand's or competitor's real name, or "Others". */
	name: string;
	kind: ShareOfVoiceTrendSeriesKind;
}

export interface ShareOfVoiceComparisonPoint {
	date: string;
	/** Exact share per series key as a 0..100 percentage; null when the day has no mention denominator. */
	values: Record<string, number | null>;
}

export interface ShareOfVoiceComparisonTrend {
	/** Fixed display order: brand, competitors in end-of-window rank, then Others when a tail exists. */
	series: ShareOfVoiceTrendSeries[];
	points: ShareOfVoiceComparisonPoint[];
}

export const SHARE_OF_VOICE_TREND_TOP_N = 6;

const asCount = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Share of voice over time for the brand and its competitors, with the same
 * per-prompt carry-forward as shareOfVoiceTimeSeriesLVCF but carrying each
 * prompt's whole {brand, competitors} snapshot: a new run replaces the previous
 * snapshot entirely, so a competitor missing from the latest answer counts as
 * zero rather than lingering from an older day.
 *
 * The competitors shown are the top `topN` of the end-of-window standings (the
 * same ranking as the leaderboard and donut), frozen for the whole axis; every
 * other competitor is summed into "Others" by count. Each day's denominator is
 * the brand plus all competitors, including that tail, so the brand's exact
 * share here rounds to the legacy series on every day.
 */
export function shareOfVoiceComparisonTimeSeriesLVCF(
	brandName: string,
	brandDaily: Array<{ promptId: string; date: string; brand: number }>,
	competitorDaily: Array<{ promptId: string; date: string; competitor: string; mentions: number }>,
	dateRange: string[],
	topN = SHARE_OF_VOICE_TREND_TOP_N,
): ShareOfVoiceComparisonTrend {
	if (dateRange.length === 0) return { series: [], points: [] };

	const byPrompt = groupObservations(
		brandDaily.map((r) => ({ ...r, brand: asCount(r.brand) })),
		competitorDaily.map((r) => ({ ...r, mentions: asCount(r.mentions) })),
	);

	// Per-day totals after every prompt's snapshot has been replaced or carried.
	const brandByDate = new Map<string, number>();
	const competitorsByDate = new Map<string, Map<string, number>>();
	for (const [, dateMap] of byPrompt) {
		const observations = [...dateMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		if (observations.length === 0) continue;
		let next = 0;
		let carried = observations[0][1];
		for (const date of dateRange) {
			while (next < observations.length && observations[next][0] <= date) carried = observations[next++][1];
			brandByDate.set(date, (brandByDate.get(date) ?? 0) + carried.brand);
			let bucket = competitorsByDate.get(date);
			if (!bucket) {
				bucket = new Map();
				competitorsByDate.set(date, bucket);
			}
			for (const [name, mentions] of carried.competitors) bucket.set(name, (bucket.get(name) ?? 0) + mentions);
		}
	}

	const lastDate = dateRange[dateRange.length - 1];
	const ranked = [...(competitorsByDate.get(lastDate) ?? new Map<string, number>()).entries()]
		.map(([name, mentions]) => ({ name, mentions }))
		.filter((c) => c.mentions > 0)
		.sort(compareMentionsDescThenName)
		.slice(0, topN);
	const shown = new Map(ranked.map((c, i) => [c.name, `competitor-${i + 1}`]));

	const series: ShareOfVoiceTrendSeries[] = [
		{ key: "brand", name: brandName, kind: "brand" },
		...ranked.map((c) => ({ key: shown.get(c.name) as string, name: c.name, kind: "competitor" as const })),
	];

	let othersEverPositive = false;
	const points = dateRange.map((date) => {
		const bucket = competitorsByDate.get(date);
		const brand = brandByDate.get(date);
		const values: Record<string, number | null> = {};
		if (bucket === undefined || brand === undefined) {
			for (const s of series) values[s.key] = null;
			values.others = null;
			return { date, values };
		}
		const shownCounts = new Map<string, number>();
		let others = 0;
		let total = brand;
		for (const [name, mentions] of bucket) {
			total += mentions;
			const key = shown.get(name);
			if (key) shownCounts.set(key, (shownCounts.get(key) ?? 0) + mentions);
			else others += mentions;
		}
		if (others > 0) othersEverPositive = true;
		const share = (count: number) => (total === 0 ? null : (count / total) * 100);
		values.brand = share(brand);
		for (const c of ranked) {
			const key = shown.get(c.name) as string;
			values[key] = share(shownCounts.get(key) ?? 0);
		}
		values.others = share(others);
		return { date, values };
	});

	if (othersEverPositive) {
		series.push({ key: "others", name: "Others", kind: "others" });
	} else {
		for (const p of points) delete p.values.others;
	}

	return { series, points };
}
