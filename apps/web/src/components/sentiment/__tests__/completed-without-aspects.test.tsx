/**
 * V5-RED-017 — a completed analysis with no aspect rows is a complete result
 * to the page: the leaderboard shows the entity's sentiment without any
 * analysis-level "Partial" or "aspect excluded" cue. The existing coverage
 * cue (classified < mentions) is unchanged.
 */
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SentimentLeaderboard } from "@/components/sentiment/leaderboard";
import type { SentimentEntityRow } from "@/server/sentiment";

function row(patch: Partial<SentimentEntityRow> = {}): SentimentEntityRow {
	const mentions = patch.mentions ?? 6;
	const classified = patch.classified ?? 6;
	return {
		key: "brand",
		entityType: "brand",
		competitorId: null,
		name: "Sent V5",
		isBrand: true,
		mentions,
		classified,
		sample: classified,
		counts: { positive: classified, neutral: 0, mixed: 0, negative: 0 },
		metrics: {
			sentiment: 70,
			mentionVisibility: 50,
			sampleVisibility: 50,
			positiveVisibility: 50,
			negativeVisibility: 0,
			positiveMix: 100,
			neutralMix: 0,
			mixedMix: 0,
			negativeMix: 0,
			analysisCoverage: (classified / mentions) * 100,
			partial: classified < mentions,
		},
		lowSample: false,
		...patch,
	};
}

function render(rows: SentimentEntityRow[]) {
	return renderToStaticMarkup(
		<TooltipProvider>
			<SentimentLeaderboard
				rows={rows}
				chartRoster={["brand"]}
				eligibleResponses={12}
				aspectLabel={null}
				expandedKey={null}
				onToggle={() => {}}
				domainFor={() => undefined}
				renderExpanded={() => null}
			/>
		</TooltipProvider>,
	);
}

describe("V5-RED-017 completed analyses without aspects render as complete", () => {
	it("shows the score and no Partial / excluded cue when every mention is classified", () => {
		const html = render([row()]);
		expect(html).toContain("70");
		expect(html).not.toMatch(/partial/i);
		expect(html).not.toMatch(/excluded/i);
	});

	it("keeps the existing coverage cue when mentions are still unclassified", () => {
		const html = render([row({ mentions: 6, classified: 4 })]);
		expect(html).toMatch(/Partial/);
		expect(html).toMatch(/4 of 6 mentions analyzed so far/);
	});
});
