import { describe, expect, it } from "vitest";
import {
	bucketForRange,
	computeEntityMetrics,
	type EntityCounts,
	selectChartRoster,
	sortEntityRows,
	splitExtremes,
} from "../metrics";
import { isScoreCategoryConsistent } from "../types";

describe("UT-SNT-001 score/category rules", () => {
	it("accepts only the canonical pairs", () => {
		expect(isScoreCategoryConsistent(51, "positive")).toBe(true);
		expect(isScoreCategoryConsistent(100, "positive")).toBe(true);
		expect(isScoreCategoryConsistent(50, "positive")).toBe(false);
		expect(isScoreCategoryConsistent(49, "negative")).toBe(true);
		expect(isScoreCategoryConsistent(0, "negative")).toBe(true);
		expect(isScoreCategoryConsistent(50, "negative")).toBe(false);
		expect(isScoreCategoryConsistent(50, "neutral")).toBe(true);
		expect(isScoreCategoryConsistent(50, "mixed")).toBe(true);
		expect(isScoreCategoryConsistent(51, "mixed")).toBe(false);
		expect(isScoreCategoryConsistent(49, "neutral")).toBe(false);
		expect(isScoreCategoryConsistent(50.5, "neutral")).toBe(false);
		expect(isScoreCategoryConsistent(101, "positive")).toBe(false);
	});

	it("yields null sentiment when nothing is classified and null visibilities when T = 0", () => {
		const none = computeEntityMetrics({
			eligibleResponses: 0,
			mentions: 0,
			classified: 0,
			positive: 0,
			neutral: 0,
			mixed: 0,
			negative: 0,
			scoreSum: 0,
		});
		expect(none.sentiment).toBeNull();
		expect(none.mentionVisibility).toBeNull();
		expect(none.positiveVisibility).toBeNull();
		expect(none.analysisCoverage).toBeNull();
		expect(none.partial).toBe(false);

		const unclassified = computeEntityMetrics({
			eligibleResponses: 10,
			mentions: 3,
			classified: 0,
			positive: 0,
			neutral: 0,
			mixed: 0,
			negative: 0,
			scoreSum: 0,
		});
		expect(unclassified.sentiment).toBeNull();
		expect(unclassified.mentionVisibility).toBe(30);
		expect(unclassified.positiveVisibility).toBe(0);
		expect(unclassified.analysisCoverage).toBe(0);
		expect(unclassified.partial).toBe(true);
	});

	it("keeps full precision (rounding is the display's job)", () => {
		const m = computeEntityMetrics({
			eligibleResponses: 3,
			mentions: 3,
			classified: 3,
			positive: 1,
			neutral: 1,
			mixed: 0,
			negative: 1,
			scoreSum: 100 + 50 + 20,
		});
		expect(m.sentiment).toBeCloseTo(56.666666, 5);
		expect(m.positiveVisibility).toBeCloseTo(33.333333, 5);
	});
});

describe("UT-SNT-002 canonical fixture", () => {
	const T = 10;
	const entityA: EntityCounts = {
		eligibleResponses: T,
		mentions: 5,
		classified: 5,
		positive: 2,
		neutral: 0,
		mixed: 1,
		negative: 2,
		scoreSum: 100 + 80 + 50 + 40 + 30,
	};
	const entityB: EntityCounts = {
		eligibleResponses: T,
		mentions: 1,
		classified: 1,
		positive: 1,
		neutral: 0,
		mixed: 0,
		negative: 0,
		scoreSum: 90,
	};

	it("entity A: 60 / 50 % / 20 % / 20 % / 40-0-20-40 / 100 %", () => {
		const m = computeEntityMetrics(entityA);
		expect(m.sentiment).toBe(60);
		expect(m.mentionVisibility).toBe(50);
		expect(m.positiveVisibility).toBe(20);
		expect(m.negativeVisibility).toBe(20);
		expect(m.positiveMix).toBe(40);
		expect(m.neutralMix).toBe(0);
		expect(m.mixedMix).toBe(20);
		expect(m.negativeMix).toBe(40);
		expect(m.analysisCoverage).toBe(100);
		expect(m.partial).toBe(false);
	});

	it("entity B: 90 / 10 % and outranks A by sentiment but not in the roster", () => {
		const m = computeEntityMetrics(entityB);
		expect(m.sentiment).toBe(90);
		expect(m.mentionVisibility).toBe(10);
		const rows = [
			{ key: "a", name: "Alpha", mentions: 5, classified: 5, metrics: computeEntityMetrics(entityA) },
			{ key: "b", name: "Bravo", mentions: 1, classified: 1, metrics: m },
		];
		expect(sortEntityRows(rows, "sentiment").map((r) => r.key)).toEqual(["b", "a"]);
		expect(selectChartRoster(rows, 1).map((r) => r.key)).toEqual(["a"]);
	});
});

describe("UT-SNT-008 buckets, roster and sorting", () => {
	it("chooses daily for month-sized windows, weekly ≤ 180, monthly beyond", () => {
		expect(bucketForRange(7)).toBe("day");
		expect(bucketForRange(32)).toBe("day");
		expect(bucketForRange(35)).toBe("day");
		expect(bucketForRange(36)).toBe("week");
		expect(bucketForRange(180)).toBe("week");
		expect(bucketForRange(181)).toBe("month");
		expect(bucketForRange(2000)).toBe("month");
	});

	it("selects the chart roster by mentions, then name, then key — never by score", () => {
		const roster = selectChartRoster(
			[
				{ key: "z", name: "Zeta", mentions: 3 },
				{ key: "b2", name: "beta", mentions: 3 },
				{ key: "b1", name: "Beta", mentions: 3 },
				{ key: "q", name: "Quiet", mentions: 0 },
				{ key: "m", name: "Mega", mentions: 9 },
			],
			3,
		);
		expect(roster.map((r) => r.key)).toEqual(["m", "b1", "b2"]);
	});

	it("sorts nulls last and breaks sentiment ties by classified mentions, then name", () => {
		const base = { eligibleResponses: 10, neutral: 0, mixed: 0, negative: 0 };
		const rows = [
			{
				key: "n",
				name: "Nil",
				mentions: 2,
				classified: 0,
				metrics: computeEntityMetrics({ ...base, mentions: 2, classified: 0, positive: 0, scoreSum: 0 }),
			},
			{
				key: "x",
				name: "Xi",
				mentions: 4,
				classified: 4,
				metrics: computeEntityMetrics({ ...base, mentions: 4, classified: 4, positive: 4, scoreSum: 320 }),
			},
			{
				key: "y",
				name: "Ypsilon",
				mentions: 2,
				classified: 2,
				metrics: computeEntityMetrics({ ...base, mentions: 2, classified: 2, positive: 2, scoreSum: 160 }),
			},
			{
				key: "a",
				name: "Alpha",
				mentions: 2,
				classified: 2,
				metrics: computeEntityMetrics({ ...base, mentions: 2, classified: 2, positive: 2, scoreSum: 160 }),
			},
		];
		expect(sortEntityRows(rows, "sentiment").map((r) => r.key)).toEqual(["x", "a", "y", "n"]);
		expect(sortEntityRows(rows, "mentions").map((r) => r.key)).toEqual(["x", "a", "n", "y"]);
		expect(sortEntityRows(rows, "name").map((r) => r.key)).toEqual(["a", "n", "x", "y"]);
		expect(sortEntityRows(rows, "positiveVisibility").map((r) => r.key)).toEqual(["x", "a", "y", "n"]);
	});
});

describe("UT-SNT-007 deterministic extremes", () => {
	const obs = (score: number, i: number) => ({
		score,
		runCreatedAt: `2026-09-${String(10 + (i % 3)).padStart(2, "0")}T00:00:00Z`,
		promptId: `p${i % 2}`,
		promptRunId: `r${String(i).padStart(2, "0")}`,
	});

	it("returns 10 highest and 10 lowest without overlap when enough exist", () => {
		const rows = Array.from({ length: 25 }, (_, i) => obs(i * 4, i));
		const { highest, lowest } = splitExtremes(rows, 10);
		expect(highest).toHaveLength(10);
		expect(lowest).toHaveLength(10);
		expect(highest[0].score).toBe(96);
		expect(lowest[0].score).toBe(0);
		const ids = new Set([...highest, ...lowest].map((r) => r.promptRunId));
		expect(ids.size).toBe(20);
	});

	it("allocates unique records from both ends when fewer than 20 exist", () => {
		const rows = Array.from({ length: 7 }, (_, i) => obs(10 * i, i));
		const { highest, lowest } = splitExtremes(rows, 10);
		expect(highest.map((r) => r.score)).toEqual([60, 50, 40, 30]);
		expect(lowest.map((r) => r.score)).toEqual([0, 10, 20]);
	});

	it("breaks score ties by run timestamp, prompt id, then run id", () => {
		const rows = [
			{ score: 50, runCreatedAt: "2026-09-11T00:00:00Z", promptId: "p1", promptRunId: "r2" },
			{ score: 50, runCreatedAt: "2026-09-11T00:00:00Z", promptId: "p1", promptRunId: "r1" },
			{ score: 50, runCreatedAt: "2026-09-10T00:00:00Z", promptId: "p9", promptRunId: "r9" },
			{ score: 50, runCreatedAt: "2026-09-11T00:00:00Z", promptId: "p0", promptRunId: "r5" },
		];
		const { highest, lowest } = splitExtremes(rows, 10);
		expect([...lowest, ...highest.slice().reverse()].map((r) => r.promptRunId)).toEqual(["r9", "r5", "r1", "r2"]);
	});
});
