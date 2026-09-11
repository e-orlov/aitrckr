/**
 * F-07R1 — the one ordered slice array behind the Share of Voice donut and its
 * visible brand list. Traceability: F07R1-FR-003/004/005/006/007/008, NFR-003.
 */
import { describe, expect, it } from "vitest";
import { buildShareOfVoiceSlices } from "@/components/share-of-voice-donut";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import type { ShareOfVoiceEntry } from "@/server/analysis";

function entries(brand: [string, number], competitors: Array<[string, number]>): ShareOfVoiceEntry[] {
	const total = brand[1] + competitors.reduce((s, [, m]) => s + m, 0);
	return [
		{ name: brand[0], mentions: brand[1], share: total ? brand[1] / total : 0, isBrand: true, prompts: 1 },
		...competitors.map(([name, mentions]) => ({
			name,
			mentions,
			share: total ? mentions / total : 0,
			isBrand: false,
			prompts: 1,
		})),
	];
}

// The CP0 production standings (47 mentions): 38/15/13/11/6/6/4 + Others 6 = 99%.
const PRODUCTION_LIKE = entries(
	["ARAG", 18],
	[
		["WGV", 7],
		["HUK-COBURG", 6],
		["ADAC", 5],
		["AUXILIA", 3],
		["ÖRAG", 3],
		["ADVOCARD", 2],
		["Allianz", 1],
		["DEURAG", 1],
		["R+V", 1],
	],
);

describe("buildShareOfVoiceSlices", () => {
	it("renders the brand, the Top-6 in server order and Others last (FR-003, FR-004, FR-007)", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE);
		expect(slices.map((s) => s.name)).toEqual([
			"ARAG",
			"WGV",
			"HUK-COBURG",
			"ADAC",
			"AUXILIA",
			"ÖRAG",
			"ADVOCARD",
			"Others",
		]);
		expect(slices.map((s) => s.kind)).toEqual([
			"brand",
			"competitor",
			"competitor",
			"competitor",
			"competitor",
			"competitor",
			"competitor",
			"others",
		]);
		expect(slices.filter((s) => s.kind === "brand")).toHaveLength(1);
	});

	it("rounds each share once from the full denominator and does not renormalise the 99% total (FR-008)", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE);
		expect(slices.map((s) => s.percent)).toEqual([38, 15, 13, 11, 6, 6, 4, 6]);
		expect(slices.reduce((s, x) => s + x.percent, 0)).toBe(99);
		// The unrounded composition is still exactly 100% of the same total.
		const total = slices.reduce((s, x) => s + x.value, 0);
		expect(total).toBe(47);
		expect(slices.reduce((s, x) => s + x.value / total, 0)).toBeCloseTo(1, 12);
		// The same rounding the leaderboard applies to `share`.
		for (const e of PRODUCTION_LIKE.slice(0, 7)) {
			expect(slices.find((s) => s.name === e.name)?.percent).toBe(Math.round(e.share * 100));
		}
	});

	it("gives Others the whole hidden tail, the grey colour and no single entity's identity (FR-007)", () => {
		const others = buildShareOfVoiceSlices(PRODUCTION_LIKE).at(-1);
		expect(others).toMatchObject({
			key: "others",
			kind: "others",
			name: "Others",
			value: 3,
			color: OTHERS_COLOR,
			percent: 6,
		});
		expect(others?.domain).toBeUndefined();
	});

	it("omits Others when no competitor is hidden (FR-007)", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE.slice(0, 7));
		expect(slices).toHaveLength(7);
		expect(slices.some((s) => s.kind === "others")).toBe(false);
		// 44 mentions: 18/7/6/5/3/3/2 → a displayed total of 101%, again left as is.
		expect(slices.map((s) => s.percent)).toEqual([41, 16, 14, 11, 7, 7, 5]);
		expect(slices.reduce((s, x) => s + x.percent, 0)).toBe(101);
	});

	it("shows only the entities that exist when there are fewer than six competitors (FR-003)", () => {
		const slices = buildShareOfVoiceSlices(
			entries(
				["Acme", 4],
				[
					["Globex", 2],
					["Initech", 1],
				],
			),
		);
		expect(slices.map((s) => [s.name, s.kind, s.percent])).toEqual([
			["Acme", "brand", 57],
			["Globex", "competitor", 29],
			["Initech", "competitor", 14],
		]);
	});

	it("assigns colours by position exactly as the donut sectors did (FR-005, FR-008)", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE);
		expect(slices.map((s) => s.color)).toEqual([BRAND_COLOR, ...COMPETITOR_PALETTE, OTHERS_COLOR]);
	});

	it("keeps the server's tie order and folds the seventh tied competitor into Others (FR-004)", () => {
		// Server order for equal counts is by name; a Top-6 boundary tie must not be re-sorted here.
		const tied = entries(
			["Acme", 6],
			[
				["Alpha", 2],
				["Bravo", 2],
				["Charlie", 2],
				["Delta", 2],
				["Echo", 2],
				["Foxtrot", 2],
				["Golf", 2],
			],
		);
		const slices = buildShareOfVoiceSlices(tied);
		expect(slices.map((s) => s.name)).toEqual([
			"Acme",
			"Alpha",
			"Bravo",
			"Charlie",
			"Delta",
			"Echo",
			"Foxtrot",
			"Others",
		]);
		expect(slices.at(-1)?.value).toBe(2);
	});

	it("mirrors the server order when the brand is not the leader — the list follows the donut, not a re-sort (FR-004)", () => {
		const trailing: ShareOfVoiceEntry[] = [
			{ name: "Globex", mentions: 5, share: 5 / 9, isBrand: false, prompts: 1 },
			{ name: "Acme", mentions: 4, share: 4 / 9, isBrand: true, prompts: 1 },
		];
		expect(buildShareOfVoiceSlices(trailing).map((s) => [s.name, s.kind])).toEqual([
			["Globex", "competitor"],
			["Acme", "brand"],
		]);
	});

	it("drops entities without mentions and returns nothing when nobody was mentioned", () => {
		expect(buildShareOfVoiceSlices(entries(["Acme", 3], [["Globex", 0]]))).toHaveLength(1);
		expect(buildShareOfVoiceSlices(entries(["Acme", 0], [["Globex", 0]]))).toEqual([]);
		expect(buildShareOfVoiceSlices([])).toEqual([]);
	});

	it("uses stable identity keys and carries the domain for real entities only", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE, 6, (name) => `${name.toLowerCase()}.example`);
		expect(slices.map((s) => s.key)).toEqual([
			"brand:ARAG",
			"competitor:WGV",
			"competitor:HUK-COBURG",
			"competitor:ADAC",
			"competitor:AUXILIA",
			"competitor:ÖRAG",
			"competitor:ADVOCARD",
			"others",
		]);
		expect(slices[0].domain).toBe("arag.example");
		expect(slices.at(-1)?.domain).toBeUndefined();
	});
});
