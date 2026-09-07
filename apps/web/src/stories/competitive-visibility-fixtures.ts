/**
 * Deterministic Competitive AI Visibility payloads for stories, built with the
 * production aggregation from synthetic per-prompt rows so every fixture obeys
 * the same invariants as a real response.
 */
import {
	computeCompetitiveVisibility,
	type PromptDayCompetitorRuns,
	type PromptDayRuns,
} from "@/lib/competitive-visibility";
import type { CompetitiveVisibilityResponse } from "@/server/competitive-visibility";

const BRAND = { id: "acme", name: "Acme" };

export const COMPETITORS = [
	{ id: "c-globex", name: "Globex" },
	{ id: "c-initech", name: "Initech" },
	{ id: "c-umbrella", name: "Umbrella" },
	{ id: "c-hooli", name: "Hooli" },
	{ id: "c-stark", name: "Stark Industries" },
	{ id: "c-wayne", name: "Wayne Enterprises" },
	{ id: "c-wonka", name: "Wonka" },
	{ id: "c-tyrell", name: "Tyrell" },
];

export function dates(count: number, last = "2026-09-06"): string[] {
	const [y, m, d] = last.split("-").map(Number);
	const out: string[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const day = new Date(Date.UTC(y, m - 1, d - i));
		out.push(day.toISOString().slice(0, 10));
	}
	return out;
}

function respond(
	competitors: { id: string; name: string }[],
	promptRuns: PromptDayRuns[],
	competitorRuns: PromptDayCompetitorRuns[],
	range: string[],
	windowCitations = 128,
): CompetitiveVisibilityResponse {
	return {
		...computeCompetitiveVisibility(BRAND, competitors, promptRuns, competitorRuns, range),
		brand: BRAND,
		dateRange: { fromDate: range[0], toDate: range[range.length - 1] },
		windowCitations,
	};
}

/**
 * The protected production shape: 33 evaluated prompts, 41 carried runs, the
 * brand in 19 runs across 14 prompts → 46% and 14 (42%) / 33. Eight tracked
 * competitors with distinct values, one of them never mentioned.
 */
export const DATES_32 = dates(32);
/** Which competitors prompt `p` names in its final run, and in how many of its `runs`. */
const FINAL_MENTIONS: Array<
	[name: string, appliesTo: (p: number) => boolean, runs: (runs: number, p: number) => number]
> = [
	["Globex", (p) => p <= 12, (runs, p) => Math.min(runs, p <= 4 ? 2 : 1)], // 4×2 + 8×1 = 16 runs, 12 prompts
	["Initech", (p) => p % 3 === 0, () => 1], // 11 prompts → 11 runs
	["Umbrella", (p) => p <= 8, (runs) => runs], // 16 runs, 8 prompts
	["Hooli", (p) => p % 5 === 0, () => 1], // 6
	["Stark Industries", (p) => p % 7 === 0, () => 1], // 4
	["Wayne Enterprises", (p) => p % 11 === 0, () => 1], // 3
	["Wonka", (p) => p === 33, () => 1], // 1
	// Tyrell: never mentioned → 0%.
];

function buildDefault(): CompetitiveVisibilityResponse {
	const promptRuns: PromptDayRuns[] = [];
	const competitorRuns: PromptDayCompetitorRuns[] = [];
	const first = DATES_32[0];
	const last = DATES_32[DATES_32.length - 1];
	// Every prompt has an early observation with few mentions, so the first days
	// differ from the end and the trend has a shape.
	for (let p = 1; p <= 33; p++) {
		const id = `P${p}`;
		promptRuns.push({ promptId: id, date: first, runs: 1, brandRuns: p % 3 === 0 ? 1 : 0 });
		if (p % 4 === 0) competitorRuns.push({ promptId: id, date: first, competitor: "Globex", runs: 1 });
		// Final observation: prompts 1–8 run twice that day, the rest once → 41 runs.
		const runs = p <= 8 ? 2 : 1;
		// Brand: prompts 1–5 mention it in both runs (10), prompts 9–17 in their single run (9) → 19 runs, 14 prompts.
		const brandRuns = p <= 5 ? 2 : p >= 9 && p <= 17 ? 1 : 0;
		promptRuns.push({ promptId: id, date: last, runs, brandRuns });
		for (const [competitor, appliesTo, count] of FINAL_MENTIONS) {
			if (appliesTo(p)) competitorRuns.push({ promptId: id, date: last, competitor, runs: count(runs, p) });
		}
	}
	// A mid-window observation on one prompt so the middle of the trend moves too.
	promptRuns.push({ promptId: "P20", date: DATES_32[15], runs: 1, brandRuns: 1 });
	competitorRuns.push({ promptId: "P20", date: DATES_32[15], competitor: "Globex", runs: 1 });
	return respond(COMPETITORS, promptRuns, competitorRuns, DATES_32, 945);
}
export const mockCompetitiveVisibility = buildDefault();

/** Brand only, no competitors configured. */
export const mockCompetitiveVisibilityBrandOnly = respond(
	[],
	[
		{ promptId: "P1", date: DATES_32[0], runs: 1, brandRuns: 1 },
		{ promptId: "P2", date: DATES_32[10], runs: 2, brandRuns: 1 },
		{ promptId: "P1", date: DATES_32[31], runs: 1, brandRuns: 1 },
	],
	[],
	DATES_32,
	7,
);

/** Three competitors incl. one at exactly 100% and one at 0%, plus a very long name. */
export const LONG_NAME = "Württembergische Gemeinde-Versicherung Rechtsschutz AG & Co. KGaA";
export const mockCompetitiveVisibilityEdge = respond(
	[
		{ id: "c-full", name: LONG_NAME },
		{ id: "c-zero", name: "Zero Corp" },
		{ id: "c-half", name: "Halfway" },
	],
	[
		{ promptId: "P1", date: DATES_32[31], runs: 2, brandRuns: 2 },
		{ promptId: "P2", date: DATES_32[31], runs: 2, brandRuns: 0 },
	],
	[
		{ promptId: "P1", date: DATES_32[31], competitor: LONG_NAME, runs: 2 },
		{ promptId: "P2", date: DATES_32[31], competitor: LONG_NAME, runs: 2 },
		{ promptId: "P1", date: DATES_32[31], competitor: "Halfway", runs: 2 },
	],
	DATES_32,
	3,
);

/** A window whose first ten days have no observation at all (gaps, then data). */
export const DATES_20 = dates(20);
export const mockCompetitiveVisibilitySparse = (() => {
	const range = DATES_20;
	const r = respond(
		COMPETITORS.slice(0, 2),
		[
			{ promptId: "P1", date: range[10], runs: 2, brandRuns: 1 },
			{ promptId: "P1", date: range[19], runs: 2, brandRuns: 2 },
		],
		[{ promptId: "P1", date: range[10], competitor: "Globex", runs: 1 }],
		range,
	);
	// The carry seeds every day with the first observation; make the leading ten
	// days genuine gaps to exercise the null → gap rendering.
	for (let i = 0; i < 10; i++) {
		r.points[i] = {
			date: range[i],
			runs: null,
			mentioned: {},
			visibility: Object.fromEntries(r.series.map((s) => [s.key, null])),
		};
	}
	return r;
})();

/** No eligible data at all. */
export const mockCompetitiveVisibilityEmpty = respond(COMPETITORS.slice(0, 3), [], [], DATES_32, 0);
