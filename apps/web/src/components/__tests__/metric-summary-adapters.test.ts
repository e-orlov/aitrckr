/**
 * UI-R1 — the per-metric adapters that turn each canonical dataset into
 * display-ready legend rows. The generic legend renders whatever it is given;
 * these tests pin what each metric gives it. Traceability: UI-R1-05/06/07/08/09.
 */
import { describe, expect, it } from "vitest";
import {
	buildCompetitiveVisibilityRings,
	competitiveVisibilityLegendItems,
} from "@/components/competitive-visibility/radial";
import { buildShareOfVoiceSlices, shareOfVoiceLegendItems } from "@/components/share-of-voice-donut";
import type { CompetitiveVisibilityEntity, CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import type { ShareOfVoiceEntry } from "@/server/analysis";

function entries(brand: [string, number], competitors: Array<[string, number]>): ShareOfVoiceEntry[] {
	const total = brand[1] + competitors.reduce((s, [, m]) => s + m, 0);
	return [
		{ name: brand[0], mentions: brand[1], share: brand[1] / total, isBrand: true, prompts: 1 },
		...competitors.map(([name, mentions]) => ({ name, mentions, share: mentions / total, isBrand: false, prompts: 1 })),
	];
}

// Production-like standings (47 mentions): 38/15/13/11/6/6/4 + Others 6 = 99 %.
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

describe("shareOfVoiceLegendItems", () => {
	it("mirrors the slices one-to-one: ids, order, colours and the once-rounded percent as text", () => {
		const slices = buildShareOfVoiceSlices(PRODUCTION_LIKE);
		const items = shareOfVoiceLegendItems(slices);
		expect(items.map((i) => i.id)).toEqual(slices.map((s) => s.key));
		expect(items.map((i) => i.label)).toEqual(slices.map((s) => s.name));
		expect(items.map((i) => i.color)).toEqual([BRAND_COLOR, ...COMPETITOR_PALETTE, OTHERS_COLOR]);
		expect(items.map((i) => i.valueLabel)).toEqual(["38%", "15%", "13%", "11%", "6%", "6%", "4%", "6%"]);
		// The adapter forwards the slice's percent; it never re-rounds or renormalises the 99 % total.
		expect(items.reduce((s, i) => s + Number.parseInt(i.valueLabel, 10), 0)).toBe(99);
	});

	it("marks only the brand as primary with the You badge; competitors and Others are muted without a badge", () => {
		const items = shareOfVoiceLegendItems(buildShareOfVoiceSlices(PRODUCTION_LIKE));
		expect(items[0]).toMatchObject({ label: "ARAG", emphasis: "primary", badgeLabel: "You" });
		expect(items.slice(1).every((i) => i.emphasis === "muted" && i.badgeLabel === undefined)).toBe(true);
		expect(items.at(-1)).toMatchObject({ id: "others", label: "Others", color: OTHERS_COLOR, valueLabel: "6%" });
	});

	it("keeps a 101 % total and omits Others when there is no tail", () => {
		const items = shareOfVoiceLegendItems(buildShareOfVoiceSlices(PRODUCTION_LIKE.slice(0, 7)));
		expect(items).toHaveLength(7);
		expect(items.some((i) => i.id === "others")).toBe(false);
		expect(items.reduce((s, i) => s + Number.parseInt(i.valueLabel, 10), 0)).toBe(101);
	});

	it("returns no rows when nobody was mentioned", () => {
		expect(shareOfVoiceLegendItems(buildShareOfVoiceSlices([]))).toEqual([]);
	});
});

const series: CompetitiveVisibilitySeries[] = [
	{ key: "brand", id: "brand", name: "Acme", isBrand: true },
	{ key: "c-globex", id: "c-globex", name: "Globex", isBrand: false },
	{ key: "c-initech", id: "c-initech", name: "Initech", isBrand: false },
];
const entity = (
	key: string,
	name: string,
	isBrand: boolean,
	visibility: number | null,
): CompetitiveVisibilityEntity => ({
	key,
	id: key,
	name,
	isBrand,
	visibility,
	mentionedRuns: 0,
	visiblePromptCount: 0,
	coveragePercent: null,
	rank: 0,
});

describe("competitiveVisibilityLegendItems", () => {
	it("mirrors the rings: series order, independent percentages that may exceed 100 %, brand first with You", () => {
		const rings = buildCompetitiveVisibilityRings(series, [
			entity("brand", "Acme", true, 46.3),
			entity("c-globex", "Globex", false, 39.02),
			entity("c-initech", "Initech", false, 38.6),
		]);
		const items = competitiveVisibilityLegendItems(rings);
		expect(items.map((i) => i.id)).toEqual(["brand", "c-globex", "c-initech"]);
		expect(items.map((i) => i.valueLabel)).toEqual(["46%", "39%", "39%"]);
		expect(items.reduce((s, i) => s + Number.parseInt(i.valueLabel, 10), 0)).toBeGreaterThan(100);
		expect(items[0]).toMatchObject({ emphasis: "primary", badgeLabel: "You", color: BRAND_COLOR });
		expect(items[1]).toMatchObject({ emphasis: "muted", color: COMPETITOR_PALETTE[0] });
		expect(items[1].badgeLabel).toBeUndefined();
	});

	it("renders a missing denominator as the em dash and a zero as 0%", () => {
		const rings = buildCompetitiveVisibilityRings(series, [
			entity("brand", "Acme", true, null),
			entity("c-globex", "Globex", false, 0),
			entity("c-initech", "Initech", false, 100),
		]);
		expect(competitiveVisibilityLegendItems(rings).map((i) => i.valueLabel)).toEqual(["—", "0%", "100%"]);
	});

	it("skips series without an entity row instead of inventing one", () => {
		const rings = buildCompetitiveVisibilityRings(series, [entity("brand", "Acme", true, 50)]);
		expect(competitiveVisibilityLegendItems(rings).map((i) => i.label)).toEqual(["Acme"]);
	});
});
