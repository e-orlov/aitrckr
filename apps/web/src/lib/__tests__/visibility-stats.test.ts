import { describe, expect, it } from "vitest";
import {
	compareMentionsDescThenName,
	computeShareOfVoice,
	computeVolatility,
	type DailyDomainCount,
	type ShareOfVoiceComparisonTrend,
	shareOfVoiceComparisonTimeSeriesLVCF,
	shareOfVoiceLeaderboardLVCF,
	shareOfVoiceTimeSeriesLVCF,
	stabilityScore,
} from "@/lib/visibility-stats";

/** Helper: build daily rows from a {date: {domain: count}} spec. */
function rows(spec: Record<string, Record<string, number>>): DailyDomainCount[] {
	const out: DailyDomainCount[] = [];
	for (const [date, domains] of Object.entries(spec)) {
		for (const [domain, count] of Object.entries(domains)) {
			out.push({ date, domain, count });
		}
	}
	return out;
}

describe("computeVolatility", () => {
	it("returns nulls with zero transitions when there are fewer than two days", () => {
		expect(computeVolatility([])).toEqual({ setVolatility: null, weightedVolatility: null, dayTransitions: 0 });
		expect(computeVolatility(rows({ "2026-01-01": { a: 1, b: 1 } }))).toEqual({
			setVolatility: null,
			weightedVolatility: null,
			dayTransitions: 0,
		});
	});

	it("is zero for an identical domain set every day", () => {
		const r = computeVolatility(rows({ "2026-01-01": { a: 1, b: 1 }, "2026-01-02": { a: 1, b: 1 } }));
		expect(r.setVolatility).toBe(0);
		expect(r.weightedVolatility).toBe(0);
		expect(r.dayTransitions).toBe(1);
	});

	it("is one for completely disjoint sets each day", () => {
		const r = computeVolatility(rows({ "2026-01-01": { a: 1 }, "2026-01-02": { b: 1 } }));
		expect(r.setVolatility).toBe(1);
		expect(r.weightedVolatility).toBe(1);
	});

	it("matches hand-computed Jaccard and Bray–Curtis on a mixed example", () => {
		// day1 {a,b,c} -> day2 {b,c,d}: inter=2, union=4 -> setDist 0.5
		// shares all 1/3; overlap = min(b)+min(c) = 1/3+1/3 -> weightedDist 1/3
		const r = computeVolatility(rows({ "2026-01-01": { a: 1, b: 1, c: 1 }, "2026-01-02": { b: 1, c: 1, d: 1 } }));
		expect(r.setVolatility).toBe(0.5);
		expect(r.weightedVolatility).toBeCloseTo(0.333, 3);
	});

	it("captures the orthogonality of set churn vs volume churn (pinned head, noisy tail)", () => {
		// A dominant 'hub' every day (80% of volume) with a fully-rotating tail.
		// Set churn is high (most distinct domains change) but volume churn is low
		// (the source that carries the answer is stable).
		const r = computeVolatility(rows({ "2026-01-01": { hub: 8, x: 1, y: 1 }, "2026-01-02": { hub: 8, z: 1, w: 1 } }));
		expect(r.setVolatility).toBe(0.8); // inter {hub}=1, union 5 -> 1 - 1/5
		expect(r.weightedVolatility).toBeCloseTo(0.2, 5); // overlap = min(hub .8,.8) = .8
	});

	it("averages across multiple transitions and sums duplicate same-day rows", () => {
		const r = computeVolatility(
			rows({
				"2026-01-01": { a: 1, b: 1 }, // -> day2 identical: setDist 0
				"2026-01-02": { a: 1, b: 1 }, // -> day3 disjoint: setDist 1
				"2026-01-03": { c: 1, d: 1 },
			}),
		);
		expect(r.dayTransitions).toBe(2);
		expect(r.setVolatility).toBe(0.5); // (0 + 1) / 2
	});

	it("ignores non-positive counts", () => {
		const r = computeVolatility(rows({ "2026-01-01": { a: 1, ghost: 0 }, "2026-01-02": { a: 1 } }));
		expect(r.setVolatility).toBe(0); // 'ghost' dropped, both days = {a}
	});
});

describe("stabilityScore", () => {
	it("inverts weighted volatility onto a 0-100 scale", () => {
		expect(stabilityScore(0)).toBe(100);
		expect(stabilityScore(1)).toBe(0);
		expect(stabilityScore(0.2)).toBe(80);
		expect(stabilityScore(null)).toBeNull();
	});
});

describe("computeShareOfVoice", () => {
	it("computes shares that sum to 1 and sorts by mentions desc", () => {
		const { entries, brandShare, total } = computeShareOfVoice({ name: "Nike", mentions: 10 }, [
			{ name: "Adidas", mentions: 8 },
			{ name: "Puma", mentions: 2 },
		]);
		expect(total).toBe(20);
		expect(brandShare).toBe(0.5);
		expect(entries.map((e) => e.name)).toEqual(["Nike", "Adidas", "Puma"]);
		expect(entries.find((e) => e.isBrand)?.share).toBe(0.5);
		expect(entries.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 5);
	});

	it("handles the no-data case without dividing by zero", () => {
		const { brandShare, entries } = computeShareOfVoice({ name: "Nike", mentions: 0 }, []);
		expect(brandShare).toBeNull();
		expect(entries[0]?.share).toBe(0);
	});
});

describe("shareOfVoiceTimeSeriesLVCF", () => {
	it("carries each prompt's last values forward across gap days", () => {
		const series = shareOfVoiceTimeSeriesLVCF(
			[
				{ promptId: "p1", date: "2026-01-01", brandMentions: 2, competitorMentions: 2 },
				{ promptId: "p1", date: "2026-01-03", brandMentions: 1, competitorMentions: 3 },
			],
			["2026-01-01", "2026-01-02", "2026-01-03"],
		);
		// day2 has no run, so it carries day1 (2/(2+2)=50%); day3 uses its own (1/(1+3)=25%)
		expect(series.map((s) => s.share)).toEqual([50, 50, 25]);
	});

	it("aggregates across prompts and yields null for days with no data", () => {
		const series = shareOfVoiceTimeSeriesLVCF(
			[
				{ promptId: "a", date: "2026-01-02", brandMentions: 1, competitorMentions: 0 },
				{ promptId: "b", date: "2026-01-02", brandMentions: 0, competitorMentions: 1 },
			],
			["2026-01-01", "2026-01-02"],
		);
		// day1: both prompts carry their earliest (day2) obs -> brand 1 / total 2 = 50
		expect(series[0]).toEqual({ date: "2026-01-01", share: 50 });
		expect(series[1]).toEqual({ date: "2026-01-02", share: 50 });
		expect(shareOfVoiceTimeSeriesLVCF([], ["2026-01-01"])).toEqual([{ date: "2026-01-01", share: null }]);
	});
});

describe("shareOfVoiceLeaderboardLVCF", () => {
	it("carries each prompt's last standings forward and sums per competitor", () => {
		const r = shareOfVoiceLeaderboardLVCF(
			[
				{ promptId: "p1", date: "2026-01-01", brand: 2 },
				{ promptId: "p1", date: "2026-01-03", brand: 1 },
				{ promptId: "p2", date: "2026-01-02", brand: 0 },
			],
			[
				{ promptId: "p1", date: "2026-01-01", competitor: "A", mentions: 1 },
				{ promptId: "p1", date: "2026-01-01", competitor: "B", mentions: 1 },
				{ promptId: "p1", date: "2026-01-03", competitor: "A", mentions: 3 },
				{ promptId: "p2", date: "2026-01-02", competitor: "A", mentions: 2 },
			],
			["2026-01-01", "2026-01-02", "2026-01-03"],
		);
		// p1's latest obs is day3 (brand 1, {A:3} — B is gone, not in the latest run);
		// p2's latest obs is day2 (brand 0, {A:2}).
		expect(r.brandMentions).toBe(1);
		expect(r.brandPrompts).toBe(1);
		expect(r.competitors).toEqual([{ name: "A", mentions: 5, prompts: 2 }]);
		// The implied brand share equals the trend's final point (1 / (1 + 5)).
		const fromLeaderboard = computeShareOfVoice({ name: "you", mentions: r.brandMentions }, r.competitors).brandShare;
		const trend = shareOfVoiceTimeSeriesLVCF(
			[
				{ promptId: "p1", date: "2026-01-01", brandMentions: 2, competitorMentions: 2 },
				{ promptId: "p1", date: "2026-01-03", brandMentions: 1, competitorMentions: 3 },
				{ promptId: "p2", date: "2026-01-02", brandMentions: 0, competitorMentions: 2 },
			],
			["2026-01-01", "2026-01-02", "2026-01-03"],
		);
		expect(Math.round((fromLeaderboard ?? 0) * 100)).toBe(trend[trend.length - 1].share);
	});

	it("returns empty for an empty date range", () => {
		expect(shareOfVoiceLeaderboardLVCF([], [], [])).toEqual({ brandMentions: 0, brandPrompts: 0, competitors: [] });
	});
});

describe("compareMentionsDescThenName", () => {
	it("keeps the mentions ranking and breaks ties by name regardless of input order", () => {
		const tied = [
			{ name: "Zed", mentions: 1 },
			{ name: "alpha", mentions: 1 },
			{ name: "Alpha", mentions: 1 },
			{ name: "Beta", mentions: 3 },
		];
		const expected = ["Beta", "Alpha", "Zed", "alpha"];
		expect([...tied].sort(compareMentionsDescThenName).map((c) => c.name)).toEqual(expected);
		expect([...tied].reverse().sort(compareMentionsDescThenName).map((c) => c.name)).toEqual(expected);
	});

	it("orders leaderboard ties deterministically without changing non-tied order", () => {
		const brand = [{ promptId: "p1", date: "2026-01-01", brand: 1 }];
		const comps = [
			{ promptId: "p1", date: "2026-01-01", competitor: "Zed", mentions: 2 },
			{ promptId: "p1", date: "2026-01-01", competitor: "Alpha", mentions: 2 },
			{ promptId: "p1", date: "2026-01-01", competitor: "Big", mentions: 5 },
		];
		const names = (rows: typeof comps) =>
			shareOfVoiceLeaderboardLVCF(brand, rows, ["2026-01-01"]).competitors.map((c) => c.name);
		expect(names(comps)).toEqual(["Big", "Alpha", "Zed"]);
		expect(names([...comps].reverse())).toEqual(["Big", "Alpha", "Zed"]);
	});

	it("keeps the brand ahead of a competitor with the same count in computeShareOfVoice", () => {
		const { entries } = computeShareOfVoice({ name: "Zeta", mentions: 4 }, [
			{ name: "Alpha", mentions: 4 },
			{ name: "Mid", mentions: 2 },
			{ name: "Beta", mentions: 2 },
		]);
		expect(entries.map((e) => e.name)).toEqual(["Zeta", "Alpha", "Beta", "Mid"]);
	});
});

describe("shareOfVoiceComparisonTimeSeriesLVCF", () => {
	type Obs = { p: string; d: string; brand: number; comps?: Record<string, number> };
	const D = ["2026-01-01", "2026-01-02", "2026-01-03"];

	function split(observations: Obs[]) {
		const brandDaily = observations.map((o) => ({ promptId: o.p, date: o.d, brand: o.brand }));
		const competitorDaily = observations.flatMap((o) =>
			Object.entries(o.comps ?? {}).map(([competitor, mentions]) => ({ promptId: o.p, date: o.d, competitor, mentions })),
		);
		return { brandDaily, competitorDaily };
	}
	function build(observations: Obs[], dateRange = D, brandName = "You", topN?: number) {
		const { brandDaily, competitorDaily } = split(observations);
		return shareOfVoiceComparisonTimeSeriesLVCF(brandName, brandDaily, competitorDaily, dateRange, topN);
	}
	/** Display view: series name → once-rounded percentage per date. */
	function rounded(trend: ShareOfVoiceComparisonTrend) {
		return trend.points.map((p) =>
			Object.fromEntries(
				trend.series.map((s) => {
					const v = p.values[s.key];
					return [s.name, v === null ? null : Math.round(v)];
				}),
			),
		);
	}
	const names = (trend: ShareOfVoiceComparisonTrend) => trend.series.map((s) => s.name);
	const keys = (trend: ShareOfVoiceComparisonTrend) => trend.series.map((s) => s.key);

	it("UT-01 gives exact entity shares for one prompt/day with brand + two competitors and no Others", () => {
		const t = build([{ p: "p1", d: D[0], brand: 2, comps: { A: 1, B: 1 } }], [D[0]]);
		expect(names(t)).toEqual(["You", "A", "B"]);
		expect(keys(t)).toEqual(["brand", "competitor-1", "competitor-2"]);
		expect(t.points).toEqual([{ date: D[0], values: { brand: 50, "competitor-1": 25, "competitor-2": 25 } }]);
	});

	it("UT-02 shows a brand with zero mentions as 0%, not null, when competitors are mentioned", () => {
		const t = build([{ p: "p1", d: D[0], brand: 0, comps: { A: 3 } }], [D[0]]);
		expect(t.points[0].values).toEqual({ brand: 0, "competitor-1": 100 });
	});

	it("UT-03 yields null (never NaN/Infinity) when the day's denominator is zero", () => {
		const t = build([{ p: "p1", d: D[0], brand: 0 }], [D[0]]);
		expect(names(t)).toEqual(["You"]);
		expect(t.points[0].values).toEqual({ brand: null });
		expect(JSON.stringify(t)).not.toMatch(/NaN|Infinity/);
	});

	it("UT-04 carries a prompt's whole previous snapshot across a day without a run", () => {
		const t = build([{ p: "p1", d: D[0], brand: 1, comps: { A: 3 } }], [D[0], D[1]]);
		expect(rounded(t)).toEqual([
			{ You: 25, A: 75 },
			{ You: 25, A: 75 },
		]);
	});

	it("UT-05 pre-seeds days before a prompt's first observation with that observation, like the legacy series", () => {
		const obs: Obs[] = [{ p: "p1", d: D[1], brand: 1, comps: { A: 1 } }];
		const t = build(obs, D);
		expect(rounded(t)).toEqual([
			{ You: 50, A: 50 },
			{ You: 50, A: 50 },
			{ You: 50, A: 50 },
		]);
		const legacy = shareOfVoiceTimeSeriesLVCF(
			[{ promptId: "p1", date: D[1], brandMentions: 1, competitorMentions: 1 }],
			D,
		);
		expect(legacy.map((p) => p.share)).toEqual([50, 50, 50]);
	});

	it("UT-06 replaces the whole snapshot: a competitor absent from the new run is zero, not carried", () => {
		const t = build(
			[
				{ p: "p1", d: D[0], brand: 1, comps: { A: 1, B: 1 } },
				{ p: "p1", d: D[1], brand: 1, comps: { A: 1 } },
			],
			[D[0], D[1]],
		);
		// B has no end-of-window mentions, so it is not a shown competitor; it lives in Others.
		expect(names(t)).toEqual(["You", "A", "Others"]);
		expect(rounded(t)).toEqual([
			{ You: 33, A: 33, Others: 33 },
			{ You: 50, A: 50, Others: 0 },
		]);
	});

	it("UT-07 resets every previously carried competitor when a new observation has no competitors", () => {
		const t = build(
			[
				{ p: "p1", d: D[0], brand: 1, comps: { A: 1, B: 1 } },
				{ p: "p1", d: D[1], brand: 1 },
			],
			[D[0], D[1]],
		);
		expect(names(t)).toEqual(["You", "Others"]);
		expect(rounded(t)).toEqual([
			{ You: 33, Others: 67 },
			{ You: 100, Others: 0 },
		]);
	});

	it("UT-08 aggregates staggered prompts after each prompt's own carry, not before", () => {
		const t = build([
			{ p: "p1", d: D[0], brand: 1, comps: { A: 1 } },
			{ p: "p2", d: D[1], brand: 0, comps: { B: 2 } },
			{ p: "p1", d: D[2], brand: 3 },
		]);
		expect(names(t)).toEqual(["You", "B", "Others"]);
		// day1: p1 (1,{A:1}) + p2 pre-seeded (0,{B:2}) = 4; day3: p1 (3,{}) + p2 carried (0,{B:2}) = 5.
		expect(rounded(t)).toEqual([
			{ You: 25, B: 50, Others: 25 },
			{ You: 25, B: 50, Others: 25 },
			{ You: 60, B: 40, Others: 0 },
		]);
	});

	const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`C${i + 1}`, 9 - i]));

	it("UT-09 shows exactly six competitors plus one count-level Others for nine competitors", () => {
		const t = build([{ p: "p1", d: D[0], brand: 5, comps: nine }], [D[0]]);
		expect(names(t)).toEqual(["You", "C1", "C2", "C3", "C4", "C5", "C6", "Others"]);
		expect(keys(t)).toEqual([
			"brand",
			"competitor-1",
			"competitor-2",
			"competitor-3",
			"competitor-4",
			"competitor-5",
			"competitor-6",
			"others",
		]);
		// total 5 + 45 = 50; Others = 3 + 2 + 1 = 6 → 12%.
		expect(t.points[0].values.others).toBe(12);
		expect(t.points[0].values.brand).toBe(10);
		expect(t.points[0].values["competitor-1"]).toBe(18);
	});

	it("UT-10 freezes Top-6 identity and order from the end of the window despite earlier crossings", () => {
		const t = build(
			[
				{ p: "p1", d: D[0], brand: 1, comps: { A: 1, B: 5, C: 1, Dd: 1, E: 1, F: 1, G: 10 } },
				{ p: "p1", d: D[1], brand: 1, comps: { A: 6, B: 1, C: 5, Dd: 4, E: 3, F: 2 } },
			],
			[D[0], D[1]],
		);
		expect(names(t)).toEqual(["You", "A", "C", "Dd", "E", "F", "B", "Others"]);
		// Day 1: B beats A and the tail competitor G beats everyone, yet A stays series 1 and G stays in Others.
		expect(rounded(t)[0]).toEqual({ You: 5, A: 5, C: 5, Dd: 5, E: 5, F: 5, B: 24, Others: 48 });
		expect(rounded(t)[1]).toEqual({ You: 5, A: 27, C: 23, Dd: 18, E: 14, F: 9, B: 5, Others: 0 });
	});

	it("UT-11 breaks a tie at the Top-6 boundary by name, independent of input row order", () => {
		const comps = { E1: 10, E2: 10, E3: 10, E4: 10, E5: 10, Zed: 1, Alpha: 1, Mid: 1 };
		const a = build([{ p: "p1", d: D[0], brand: 1, comps }], [D[0]]);
		const reversed = build(
			[{ p: "p1", d: D[0], brand: 1, comps: Object.fromEntries(Object.entries(comps).reverse()) }],
			[D[0]],
		);
		expect(names(a)).toEqual(["You", "E1", "E2", "E3", "E4", "E5", "Alpha", "Others"]);
		expect(reversed).toEqual(a);
	});

	it("UT-12 lists the brand first even when it is not first by mentions, and Others last", () => {
		const t = build([{ p: "p1", d: D[0], brand: 1, comps: { A: 10, B: 8, C: 6, Dd: 4, E: 2, F: 2, G: 1 } }], [D[0]]);
		expect(t.series[0]).toEqual({ key: "brand", name: "You", kind: "brand" });
		expect(t.series[t.series.length - 1]).toEqual({ key: "others", name: "Others", kind: "others" });
	});

	it("UT-13 keeps series keys collision-free for names like date, brand, Others or competitor-1", () => {
		const t = build(
			[{ p: "p1", d: D[0], brand: 1, comps: { date: 5, Others: 4, brand: 3, "competitor-1": 2, others: 1 } }],
			[D[0]],
			"brand",
		);
		expect(keys(t)).toEqual(["brand", "competitor-1", "competitor-2", "competitor-3", "competitor-4", "competitor-5"]);
		expect(names(t)).toEqual(["brand", "date", "Others", "brand", "competitor-1", "others"]);
		expect(t.points[0].date).toBe(D[0]);
		expect(t.points[0].values.brand).toBeCloseTo(100 / 16, 10);
		expect(t.points[0].values["competitor-1"]).toBeCloseTo(500 / 16, 10);
	});

	it("UT-14 sums Others from counts before dividing, which differs from summing rounded percentages", () => {
		// brand 2, A 3, B 1, C 1, D 1 → total 8. Top-1 keeps A; the tail is 3/8 = 37.5% → 38%.
		// Rounding each tail competitor first (12.5% → 13%) would give 39%.
		const t = build([{ p: "p1", d: D[0], brand: 2, comps: { A: 3, B: 1, C: 1, Dd: 1 } }], [D[0]], "You", 1);
		expect(names(t)).toEqual(["You", "A", "Others"]);
		expect(t.points[0].values.others).toBe(37.5);
		expect(Math.round(t.points[0].values.others as number)).toBe(38);
		expect(3 * Math.round(12.5)).toBe(39);
	});

	it("UT-15 counts a historical-only competitor in Others on the days it was carried positive", () => {
		const t = build(
			[
				{ p: "p1", d: D[0], brand: 1, comps: { A: 1, H: 1 } },
				{ p: "p1", d: D[2], brand: 1, comps: { A: 1 } },
			],
			D,
		);
		expect(names(t)).toEqual(["You", "A", "Others"]);
		expect(t.points.map((p) => p.values.others)).toEqual([expect.closeTo(33.333, 3), expect.closeTo(33.333, 3), 0]);
	});

	it("UT-16 omits Others entirely when no excluded competitor is ever positive", () => {
		const t = build([{ p: "p1", d: D[0], brand: 1, comps: { A: 1 } }], [D[0]]);
		expect(names(t)).toEqual(["You", "A"]);
		expect(Object.keys(t.points[0].values)).toEqual(["brand", "competitor-1"]);
	});

	it("UT-17 keeps Others as an actual 0 on zero days once the series exists", () => {
		const t = build(
			[
				{ p: "p1", d: D[0], brand: 1, comps: { A: 1, H: 1 } },
				{ p: "p1", d: D[1], brand: 1, comps: { A: 1 } },
			],
			[D[0], D[1]],
		);
		expect(t.points[1].values.others).toBe(0);
		expect(t.points[1].values.others).not.toBeNull();
	});

	it("UT-18 keeps the exact shares summing to 100 on every day with a denominator", () => {
		const t = build([
			{ p: "p1", d: D[0], brand: 5, comps: nine },
			{ p: "p2", d: D[1], brand: 0, comps: { C9: 7, X: 2 } },
			{ p: "p1", d: D[2], brand: 1, comps: { C3: 1 } },
		]);
		for (const p of t.points) {
			const sum = Object.values(p.values).reduce((s, v) => s + (v ?? 0), 0);
			expect(sum).toBeCloseTo(100, 9);
		}
	});

	const staggered: Obs[] = [
		{ p: "p1", d: D[0], brand: 2, comps: { A: 1, B: 1, C: 1 } },
		{ p: "p2", d: D[1], brand: 0, comps: { B: 3 } },
		{ p: "p1", d: D[1], brand: 1, comps: { A: 2 } },
		{ p: "p3", d: D[2], brand: 4 },
		{ p: "p2", d: D[2], brand: 1, comps: { C: 2, Dd: 1 } },
	];

	it("UT-19 rounds the brand series to the legacy shareOfVoiceTimeSeriesLVCF value on every date", () => {
		const t = build(staggered);
		const legacy = shareOfVoiceTimeSeriesLVCF(
			staggered.map((o) => ({
				promptId: o.p,
				date: o.d,
				brandMentions: o.brand,
				competitorMentions: Object.values(o.comps ?? {}).reduce((s, v) => s + v, 0),
			})),
			D,
		);
		expect(t.points.map((p) => Math.round(p.values.brand as number))).toEqual(legacy.map((p) => p.share));
		// day1 6/12, day2 5/10, day3 6/11 (p3 pre-seeded from day 3, p1 carried from day 2).
		expect(legacy.map((p) => p.share)).toEqual([50, 50, 55]);
	});

	it("UT-20 reconciles the last point with the leaderboard standings and computeShareOfVoice", () => {
		const t = build(staggered, D, "You", 2);
		const { brandDaily, competitorDaily } = split(staggered);
		const standings = shareOfVoiceLeaderboardLVCF(brandDaily, competitorDaily, D);
		const { entries } = computeShareOfVoice({ name: "You", mentions: standings.brandMentions }, standings.competitors);
		const last = t.points[t.points.length - 1].values;
		const shown = t.series.filter((s) => s.kind === "competitor");
		expect(shown.map((s) => s.name)).toEqual(standings.competitors.slice(0, 2).map((c) => c.name));
		for (const s of [t.series[0], ...shown]) {
			const entry = entries.find((e) => e.name === s.name) as (typeof entries)[number];
			expect(Math.round(last[s.key] as number)).toBe(Math.round(entry.share * 100));
		}
		const total = entries.reduce((s, e) => s + e.mentions, 0);
		const tail = standings.competitors.slice(2).reduce((s, c) => s + c.mentions, 0);
		expect(tail).toBeGreaterThan(0);
		expect(Math.round(last.others as number)).toBe(Math.round((tail / total) * 100));
	});

	it("UT-21 returns deterministic empty structures for no rows or an empty date range", () => {
		expect(shareOfVoiceComparisonTimeSeriesLVCF("You", [], [], [])).toEqual({ series: [], points: [] });
		expect(shareOfVoiceComparisonTimeSeriesLVCF("You", [], [], [D[0]])).toEqual({
			series: [{ key: "brand", name: "You", kind: "brand" }],
			points: [{ date: D[0], values: { brand: null } }],
		});
	});

	it("UT-22 renders only the competitors that exist, with no placeholder series", () => {
		const t = build([{ p: "p1", d: D[0], brand: 1, comps: { A: 1, B: 1, C: 1 } }], [D[0]]);
		expect(keys(t)).toEqual(["brand", "competitor-1", "competitor-2", "competitor-3"]);
	});

	it("UT-23 produces byte-identical output for permuted equivalent input rows", () => {
		const { brandDaily, competitorDaily } = split([...staggered, { p: "p1", d: D[0], brand: 2, comps: nine }]);
		const base = shareOfVoiceComparisonTimeSeriesLVCF("You", brandDaily, competitorDaily, D);
		const permuted = shareOfVoiceComparisonTimeSeriesLVCF(
			"You",
			[...brandDaily].reverse(),
			[...competitorDaily].sort((a, b) => (a.competitor < b.competitor ? 1 : -1)),
			D,
		);
		expect(JSON.stringify(permuted)).toBe(JSON.stringify(base));
	});

	it("UT-24 counts the persisted per-run entity observations as given, not distinct presence", () => {
		// Two runs of one prompt on one day mention the brand twice and A twice: 2 and 2, not 1 and 1.
		const t = build([{ p: "p1", d: D[0], brand: 2, comps: { A: 2, B: 1 } }], [D[0]]);
		expect(t.points[0].values).toEqual({ brand: 40, "competitor-1": 40, "competitor-2": 20 });
	});

	it("UT-25 counts every competitor of a run once per array element against the complete denominator", () => {
		const t = build([{ p: "p1", d: D[0], brand: 1, comps: { A: 1, B: 1, C: 1 } }], [D[0]]);
		expect(t.points[0].values).toEqual({ brand: 25, "competitor-1": 25, "competitor-2": 25, "competitor-3": 25 });
	});

	it("ignores negative or non-finite counts without dropping valid zeros", () => {
		const t = shareOfVoiceComparisonTimeSeriesLVCF(
			"You",
			[{ promptId: "p1", date: D[0], brand: Number.NaN }],
			[
				{ promptId: "p1", date: D[0], competitor: "A", mentions: -3 },
				{ promptId: "p1", date: D[0], competitor: "B", mentions: 2 },
			],
			[D[0]],
		);
		expect(t.points[0].values).toEqual({ brand: 0, "competitor-1": 100 });
	});
});

describe("share-of-voice percentage consistency across computation methods", () => {
	it("leaderboard, donut, and trend round the same brand share to the same percent (no double-rounding)", () => {
		// 235 / 1002 = 23.453% — exactly the band where pre-rounding the share to
		// 3 decimals first would bump the leaderboard/donut to 24% while the trend,
		// rounding the exact ratio, shows 23%. All paths must land on 23%.
		const dateRange = ["2026-01-01"];

		// Trend (per-prompt LVCF time series): rounds brand / (brand + competitor).
		const trend = shareOfVoiceTimeSeriesLVCF(
			[{ promptId: "p1", date: "2026-01-01", brandMentions: 235, competitorMentions: 767 }],
			dateRange,
		);
		const trendPct = trend[trend.length - 1].share;

		// Leaderboard -> computeShareOfVoice (the source for the table + donut).
		const standings = shareOfVoiceLeaderboardLVCF(
			[{ promptId: "p1", date: "2026-01-01", brand: 235 }],
			[{ promptId: "p1", date: "2026-01-01", competitor: "X", mentions: 767 }],
			dateRange,
		);
		const { entries, brandShare } = computeShareOfVoice(
			{ name: "you", mentions: standings.brandMentions },
			standings.competitors.map((c) => ({ name: c.name, mentions: c.mentions })),
		);
		const brandEntry = entries.find((e) => e.isBrand);
		const total = entries.reduce((s, e) => s + e.mentions, 0);

		expect(trendPct).toBe(23); // headline / sparkline
		expect(Math.round((brandShare ?? 0) * 100)).toBe(23); // headline derived from the leaderboard
		expect(Math.round((brandEntry?.share ?? 0) * 100)).toBe(23); // leaderboard table cell (formatPct)
		expect(Math.round((brandEntry!.mentions / total) * 100)).toBe(23); // donut slice
	});
});
