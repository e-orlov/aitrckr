import { describe, expect, it } from "vitest";
import { applyPerPromptLVCF, generateDateRange } from "@/lib/chart-utils";
import {
	BRAND_SERIES_KEY,
	type CompetitiveVisibilityResult,
	computeCompetitiveVisibility,
	type PromptDayCompetitorRuns,
	type PromptDayRuns,
} from "@/lib/competitive-visibility";

const BRAND = { id: "arag", name: "ARAG" };
const A = { id: "c-a", name: "Competitor A" };
const B = { id: "c-b", name: "Competitor B" };
const C = { id: "c-c", name: "Competitor C" };

const D = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

const runs = (promptId: string, date: string, runs: number, brandRuns: number): PromptDayRuns => ({
	promptId,
	date,
	runs,
	brandRuns,
});
const comp = (promptId: string, date: string, competitor: string, runs: number): PromptDayCompetitorRuns => ({
	promptId,
	date,
	competitor,
	runs,
});

const entity = (result: CompetitiveVisibilityResult, id: string) => {
	const e = result.entities.find((x) => x.id === id);
	if (!e) throw new Error(`entity ${id} missing`);
	return e;
};
const round = (v: number | null) => (v === null ? null : Math.round(v));
const lastNonNull = (result: CompetitiveVisibilityResult, key: string) => {
	for (let i = result.points.length - 1; i >= 0; i--) {
		const v = result.points[i].visibility[key];
		if (v !== null && v !== undefined) return { date: result.points[i].date, value: v };
	}
	return null;
};

describe("computeCompetitiveVisibility — the mandated Visibility ≠ Share of Voice fixture", () => {
	// Eligible population after canonical selection, all on one day:
	//   P1 / R1: Own + A;  P1 / R2: A;  P2 / R3: Own + B;  P3 / R4: nothing;  P4: no eligible run.
	const day = D[0];
	const promptRuns = [runs("P1", day, 2, 1), runs("P2", day, 1, 1), runs("P3", day, 1, 0)];
	const competitorRuns = [comp("P1", day, A.name, 2), comp("P2", day, B.name, 1)];
	const result = computeCompetitiveVisibility(BRAND, [A, B], promptRuns, competitorRuns, [day]);

	it("uses all eligible runs as the shared denominator and only prompts with data as evaluated", () => {
		expect(result.snapshotRuns).toBe(4);
		expect(result.evaluatedPromptCount).toBe(3);
		expect(result.asOfDate).toBe(day);
	});

	it("gives Own 2/4 = 50% and coverage 2 of 3 (67%)", () => {
		const own = entity(result, BRAND.id);
		expect(own.mentionedRuns).toBe(2);
		expect(round(own.visibility)).toBe(50);
		expect(own.visiblePromptCount).toBe(2);
		expect(round(own.coveragePercent)).toBe(67);
	});

	it("gives Competitor A 2/4 = 50% and coverage 1 of 3 (33%) — two runs of one prompt", () => {
		const a = entity(result, A.id);
		expect(a.mentionedRuns).toBe(2);
		expect(round(a.visibility)).toBe(50);
		expect(a.visiblePromptCount).toBe(1);
		expect(round(a.coveragePercent)).toBe(33);
	});

	it("gives Competitor B 1/4 = 25% and coverage 1 of 3 (33%)", () => {
		const b = entity(result, B.id);
		expect(b.mentionedRuns).toBe(1);
		expect(round(b.visibility)).toBe(25);
		expect(b.visiblePromptCount).toBe(1);
		expect(round(b.coveragePercent)).toBe(33);
	});

	it("lets the visibilities sum to 125% — no normalisation, no Share-of-Voice denominator", () => {
		const sum = result.entities.reduce((s, e) => s + (e.visibility ?? 0), 0);
		expect(sum).toBe(125);
		// Share of Voice would have been Own 2 of 5 mentions = 40%; Visibility is 50%.
		expect(round(entity(result, BRAND.id).visibility)).not.toBe(40);
	});

	it("never divides visible prompts by runs and keeps every coverage ≤ 100%", () => {
		for (const e of result.entities) {
			expect(e.visiblePromptCount).toBeLessThanOrEqual(result.evaluatedPromptCount);
			expect(e.coveragePercent).not.toBe((e.visiblePromptCount / result.snapshotRuns) * 100);
			expect(e.coveragePercent as number).toBeLessThanOrEqual(100);
		}
	});

	it("has no Others series and keeps the leaderboard order deterministic (Own before A on the tie, by name)", () => {
		expect(result.series.map((s) => s.key)).toEqual([BRAND_SERIES_KEY, A.id, B.id]);
		expect(result.series.some((s) => s.key === "others" || s.name === "Others")).toBe(false);
		expect(result.entities.map((e) => e.name)).toEqual(["ARAG", "Competitor A", "Competitor B"]);
		expect(result.entities.map((e) => e.rank)).toEqual([1, 2, 3]);
	});
});

describe("computeCompetitiveVisibility — canonical Visibility invariant", () => {
	it("reproduces the existing per-prompt LVCF brand series exactly on every day, and current = last non-null point", () => {
		const dateRange = generateDateRange(new Date("2026-08-20T00:00:00Z"), new Date("2026-09-05T00:00:00Z"));
		// Staggered schedules, gaps, a prompt that starts late (pre-seeded backwards) and one with several runs a day.
		const promptRuns = [
			runs("P1", "2026-08-21", 1, 1),
			runs("P1", "2026-08-24", 1, 0),
			runs("P1", "2026-09-02", 3, 2),
			runs("P2", "2026-08-30", 1, 0),
			runs("P2", "2026-09-05", 2, 1),
			runs("P3", "2026-08-20", 1, 1),
			runs("P3", "2026-09-01", 1, 1),
		];
		const legacyRows = promptRuns.map((r) => ({
			prompt_id: r.promptId,
			date: r.date,
			total_runs: r.runs,
			brand_mentioned_count: r.brandRuns,
		}));
		const legacy = applyPerPromptLVCF(legacyRows, dateRange, []);
		const result = computeCompetitiveVisibility(BRAND, [A], promptRuns, [], dateRange);

		for (const point of result.points) {
			const bucket = legacy.dailyVisibilityMap.get(point.date);
			const t = bucket ? bucket.branded.total + bucket.nonBranded.total : 0;
			const m = bucket ? bucket.branded.mentioned + bucket.nonBranded.mentioned : 0;
			const legacyValue = t === 0 ? null : Math.round((m / t) * 100);
			expect(round(point.visibility[BRAND_SERIES_KEY])).toBe(legacyValue);
			expect(point.runs).toBe(t === 0 ? null : t);
		}
		const own = entity(result, BRAND.id);
		const last = lastNonNull(result, BRAND_SERIES_KEY);
		expect(last?.date).toBe("2026-09-05");
		expect(own.visibility).toBe(last?.value);
		expect(result.windowRuns).toBe(legacy.totalBrandedRuns + legacy.totalNonBrandedRuns);
		// The aggregate is a ratio of carried counts, not the mean of rounded daily percentages.
		const meanOfDaily =
			result.points.reduce((s, p) => s + (round(p.visibility[BRAND_SERIES_KEY]) ?? 0), 0) / result.points.length;
		expect(round(own.visibility)).not.toBe(Math.round(meanOfDaily));
	});

	it("carries the whole per-prompt observation for competitors on the same snapshot as the brand", () => {
		const dateRange = D;
		const promptRuns = [runs("P1", D[0], 2, 1), runs("P1", D[3], 1, 1), runs("P2", D[1], 1, 0)];
		const competitorRuns = [comp("P1", D[0], A.name, 2), comp("P1", D[0], B.name, 1), comp("P1", D[3], B.name, 1)];
		const result = computeCompetitiveVisibility(BRAND, [A, B], promptRuns, competitorRuns, dateRange);
		const a = result.points.map((p) => p.mentioned[A.id]);
		const b = result.points.map((p) => p.mentioned[B.id]);
		const denom = result.points.map((p) => p.runs);
		// P2 is pre-seeded backwards onto D[0]; on D[3] P1's new run replaces its snapshot and A disappears.
		expect(denom).toEqual([3, 3, 3, 2, 2]);
		expect(a).toEqual([2, 2, 2, 0, 0]);
		expect(b).toEqual([1, 1, 1, 1, 1]);
		expect(round(entity(result, A.id).visibility)).toBe(0);
		expect(round(entity(result, B.id).visibility)).toBe(50);
		expect(entity(result, A.id).visiblePromptCount).toBe(0);
	});
});

describe("computeCompetitiveVisibility — counting rules", () => {
	it("counts a run once per entity even if the competitor row over-reports it", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A],
			[runs("P1", D[0], 2, 2)],
			[comp("P1", D[0], A.name, 7)],
			[D[0]],
		);
		expect(entity(result, A.id).mentionedRuns).toBe(2);
		expect(round(entity(result, A.id).visibility)).toBe(100);
		expect(round(entity(result, BRAND.id).visibility)).toBe(100);
	});

	it("lets one run count for the brand and several competitors at once", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A, B, C],
			[runs("P1", D[0], 1, 1)],
			[comp("P1", D[0], A.name, 1), comp("P1", D[0], B.name, 1), comp("P1", D[0], C.name, 1)],
			[D[0]],
		);
		expect(result.entities.map((e) => round(e.visibility))).toEqual([100, 100, 100, 100]);
	});

	it("keeps tracked competitors with no mentions at 0% and 0 (0%) instead of dropping them", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A, B],
			[runs("P1", D[0], 4, 1)],
			[comp("P1", D[0], A.name, 1)],
			[D[0]],
		);
		const b = entity(result, B.id);
		expect(b.mentionedRuns).toBe(0);
		expect(b.visibility).toBe(0);
		expect(b.visiblePromptCount).toBe(0);
		expect(b.coveragePercent).toBe(0);
		expect(result.entities).toHaveLength(3);
	});

	it("ignores mention names that are not in the tracked roster and competitor rows without a run row", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A],
			[runs("P1", D[0], 1, 0)],
			[comp("P1", D[0], "Deleted Corp", 1), comp("P9", D[0], A.name, 5)],
			[D[0]],
		);
		expect(result.snapshotRuns).toBe(1);
		expect(result.evaluatedPromptCount).toBe(1);
		expect(result.entities.map((e) => e.name)).toEqual(["ARAG", "Competitor A"]);
		expect(entity(result, A.id).mentionedRuns).toBe(0);
	});

	it("counts visible prompts as distinct prompts regardless of runs per prompt", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A],
			[runs("P1", D[0], 5, 5), runs("P2", D[0], 1, 0)],
			[comp("P1", D[0], A.name, 5)],
			[D[0]],
		);
		expect(entity(result, BRAND.id).visiblePromptCount).toBe(1);
		expect(entity(result, A.id).visiblePromptCount).toBe(1);
		expect(result.evaluatedPromptCount).toBe(2);
		expect(round(entity(result, BRAND.id).coveragePercent)).toBe(50);
		expect(round(entity(result, BRAND.id).visibility)).toBe(83);
	});
});

describe("computeCompetitiveVisibility — no-data and sparse days", () => {
	it("returns the empty result for an empty range or no observations, without NaN or Infinity", () => {
		const none = computeCompetitiveVisibility(BRAND, [A], [], [], D);
		expect(none.asOfDate).toBeNull();
		expect(none.snapshotRuns).toBe(0);
		expect(none.evaluatedPromptCount).toBe(0);
		expect(none.entities.map((e) => e.visibility)).toEqual([null, null]);
		expect(none.entities.map((e) => e.coveragePercent)).toEqual([null, null]);
		expect(none.points.map((p) => p.runs)).toEqual([null, null, null, null, null]);
		expect(none.points.every((p) => Object.values(p.visibility).every((v) => v === null))).toBe(true);
		expect(computeCompetitiveVisibility(BRAND, [A], [runs("P1", D[0], 1, 1)], [], []).points).toEqual([]);
	});

	it("treats a day before every prompt's first observation as data because the carry is seeded backwards", () => {
		const result = computeCompetitiveVisibility(BRAND, [], [runs("P1", D[2], 2, 1)], [], D);
		expect(result.points.map((p) => p.runs)).toEqual([2, 2, 2, 2, 2]);
	});

	it("does not let a trailing calendar day without runs replace the latest non-null point", () => {
		// Observations end on D[2]; D[3] and D[4] exist in the range and are carried, so the
		// current value must equal the D[4] carried value == D[2] value, not 0.
		const result = computeCompetitiveVisibility(BRAND, [A], [runs("P1", D[2], 4, 3)], [comp("P1", D[2], A.name, 1)], D);
		expect(result.asOfDate).toBe(D[4]);
		expect(round(entity(result, BRAND.id).visibility)).toBe(75);
		expect(round(entity(result, A.id).visibility)).toBe(25);
		expect(lastNonNull(result, BRAND_SERIES_KEY)).toEqual({ date: D[4], value: 75 });
	});

	it("drops rows with zero runs so they cannot create a 0-run observation", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A],
			[runs("P1", D[0], 0, 0), runs("P2", D[0], 1, 1)],
			[],
			[D[0]],
		);
		expect(result.evaluatedPromptCount).toBe(1);
		expect(result.snapshotRuns).toBe(1);
	});
});

describe("computeCompetitiveVisibility — trend roster", () => {
	const eight = ["H", "G", "F", "E", "D", "C", "B", "A"].map((n) => ({ id: `id-${n}`, name: `Comp ${n}` }));

	it("shows the brand plus at most six competitors, by Visibility then name, frozen for the axis", () => {
		const competitorRuns = eight.map((c, i) => comp("P1", D[0], c.name, Math.min(8, 8 - Math.floor(i / 2))));
		// Counts: H 8, G 8, F 7, E 7, D 6, C 6, B 5, A 5 → Top 6 = G, H, E, F, C, D (name breaks the ties).
		const result = computeCompetitiveVisibility(BRAND, eight, [runs("P1", D[0], 8, 1)], competitorRuns, D);
		expect(result.series[0]).toMatchObject({ key: BRAND_SERIES_KEY, isBrand: true });
		expect(result.series.slice(1).map((s) => s.name)).toEqual([
			"Comp G",
			"Comp H",
			"Comp E",
			"Comp F",
			"Comp C",
			"Comp D",
		]);
		expect(result.series).toHaveLength(7);
		expect(result.entities).toHaveLength(9);
		for (const point of result.points) {
			expect(Object.keys(point.visibility).sort()).toEqual(result.series.map((s) => s.key).sort());
		}
	});

	it("breaks a full tie (same runs, same name) by id and keeps the brand even at 0%", () => {
		const twins = [
			{ id: "id-z", name: "Twin" },
			{ id: "id-a", name: "Twin" },
		];
		const result = computeCompetitiveVisibility(
			BRAND,
			twins,
			[runs("P1", D[0], 2, 0)],
			[comp("P1", D[0], "Twin", 2)],
			[D[0]],
		);
		expect(result.entities.map((e) => e.id)).toEqual(["id-a", "id-z", "arag"]);
		expect(result.series.map((s) => s.key)).toEqual([BRAND_SERIES_KEY, "id-a", "id-z"]);
		expect(entity(result, BRAND.id).visibility).toBe(0);
	});

	it("does not pin the brand: a competitor with more mentions ranks above it", () => {
		const result = computeCompetitiveVisibility(
			BRAND,
			[A],
			[runs("P1", D[0], 3, 1)],
			[comp("P1", D[0], A.name, 3)],
			[D[0]],
		);
		expect(result.entities.map((e) => e.name)).toEqual(["Competitor A", "ARAG"]);
		expect(result.entities.map((e) => e.rank)).toEqual([1, 2]);
	});

	it("rejects a competitor whose id would collide with the brand series key", () => {
		expect(() => computeCompetitiveVisibility(BRAND, [{ id: "brand", name: "X" }], [], [], D)).toThrow(/collides/);
	});
});
