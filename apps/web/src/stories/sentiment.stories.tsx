import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SentimentEvidenceColumns } from "@/components/sentiment/evidence-panels";
import { SentimentCards, SentimentEmpty, SentimentError, SentimentSkeleton } from "@/components/sentiment/section";
import type { SentimentEvidenceResponse, SentimentOverviewResponse } from "@/server/sentiment";
import {
	FIXTURE_ADJACENT,
	FIXTURE_BODY,
	FIXTURE_SPAN_1,
	FIXTURE_SPAN_2,
	FIXTURE_SPAN_3,
	mockSentimentBrandOnly,
	mockSentimentEmpty,
	mockSentimentEvidence,
	mockSentimentEvidenceFew,
	mockSentimentEvidenceShapes,
	mockSentimentOverview,
	mockSentimentPending,
	mockSentimentPriceAspect,
	mockSentimentSparse,
} from "./sentiment-fixtures";

/** Story harness: owns the expansion state like the section does and renders fixture evidence. */
function SentimentHarness({
	data,
	evidence,
	sortKey = "sentiment",
	initiallyExpanded = null,
}: {
	data: SentimentOverviewResponse;
	evidence?: SentimentEvidenceResponse;
	sortKey?: "sentiment" | "mentions" | "mentionVisibility" | "positiveVisibility" | "negativeVisibility" | "name";
	initiallyExpanded?: string | null;
}) {
	const [expanded, setExpanded] = useState<string | null>(initiallyExpanded);
	return (
		<SentimentCards
			data={data}
			sortKey={sortKey}
			expandedKey={expanded}
			onToggle={(key) => setExpanded((current) => (current === key ? null : key))}
			domainFor={() => undefined}
			renderExpanded={(row) =>
				evidence ? (
					<SentimentEvidenceColumns
						data={{ ...evidence, entity: { key: row.key, name: row.name } }}
						aspect={data.aspect}
						org="acme"
						brand="acme"
					/>
				) : (
					<div data-testid="sentiment-evidence-loading">Loading…</div>
				)
			}
		/>
	);
}

const meta = {
	title: "Components/Sentiment",
	component: SentimentHarness,
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-6" style={{ width: 1200 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof SentimentHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

const q = (root: HTMLElement, testId: string) => root.querySelector(`[data-testid=${testId}]`) as HTMLElement;
const rowFor = (root: HTMLElement, name: string) =>
	[...root.querySelectorAll<HTMLElement>("[data-testid=sentiment-leaderboard-row]")].find((row) =>
		row.textContent?.includes(name),
	) as HTMLElement;
const cellText = (row: HTMLElement, index: number) =>
	row.querySelectorAll("td")[index].textContent?.replace(/\s+/g, " ").trim() ?? "";

/** ST-SNT-001 — the canonical fixture with exact metric labels. */
export const Default: Story = {
	args: { data: mockSentimentOverview() },
	play: async ({ canvasElement }) => {
		const root = canvasElement;
		await waitFor(() => expect(q(root, "sentiment-leaderboard")).toBeTruthy());
		// Headline: brand 8 of 8 → (480+50+30)/8 = 70.
		expect(q(root, "sentiment-headline").textContent).toBe("70");
		expect(q(root, "sentiment-headline-mentions").textContent).toContain("8 mentions in the selected period");
		expect(q(root, "sentiment-headline-meta").textContent).toContain(
			"8 analyzed · 8 mentions · 10 evaluated responses",
		);
		// Entity A: 60 · 5 mentions, 50 % / 20 % / 20 %, coverage 100 %.
		const a = rowFor(root, "Alpha Legal");
		expect(cellText(a, 3)).toContain("60 · 5 mentions");
		expect(cellText(a, 4)).toBe("50%");
		expect(cellText(a, 5)).toBe("20%");
		expect(cellText(a, 6)).toBe("20%");
		expect(cellText(a, 8)).toBe("100%");
		expect(cellText(a, 9)).toBe("10");
		expect(a.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
			"Positive 2, Neutral 0, Mixed 1, Negative 2",
		);
		// Entity B: 90 · 1 mention, 10 %, low sample, ranked above A by sentiment but absent from the chart roster.
		const b = rowFor(root, "Bravo Protect");
		expect(cellText(b, 3)).toContain("90 · 1 mention");
		expect(cellText(b, 3)).toContain("Low sample");
		expect(cellText(b, 4)).toBe("10%");
		const names = [...root.querySelectorAll<HTMLElement>("[data-testid=sentiment-leaderboard-row]")].map((row) =>
			cellText(row, 2).replace(/\s*You$/, ""),
		);
		expect(names.indexOf("Bravo Protect")).toBeLessThan(names.indexOf("Alpha Legal"));
		const legend = [...q(root, "sentiment-legend").querySelectorAll("li")].map((li) => li.textContent ?? "");
		expect(legend).toHaveLength(7);
		expect(legend[0]).toContain("Acme Insurance");
		expect(legend[0]).toContain("You");
		expect(legend[0]).toContain("70 · 8 mentions");
		expect(legend[1]).toContain("Alpha Legal");
		expect(legend.join("|")).not.toContain("Bravo Protect");
		expect(legend.join("|")).not.toContain("Zero Mentions");
		// Zero-mention row shows a dash, never 0 or 50.
		const zero = rowFor(root, "Zero Mentions GmbH");
		expect(cellText(zero, 3)).toContain("— · 0 mentions");
		expect(cellText(zero, 4)).toBe("0%");
		// Partial coverage cue for Echo (2 of 3 analyzed) and the page-level note.
		expect(cellText(rowFor(root, "Echo Assurance"), 3)).toContain("2 of 3 analyzed mentions");
		expect(q(root, "sentiment-coverage-note").textContent).toContain("still in progress");
		// No model/provider/classifier label anywhere.
		expect(root.textContent).not.toMatch(/openrouter|gpt-5|chatgpt|classifier/i);
		// The trend draws one line per roster entity (plus the invisible midpoint series).
		await waitFor(() =>
			expect(q(root, "sentiment-trend").querySelectorAll("path.recharts-line-curve").length).toBeGreaterThanOrEqual(7),
		);
	},
};

/** ST-SNT-002 — Mixed-heavy, low-sample and partial rows sorted by Negative Visibility. */
export const SortedByNegativeVisibility: Story = {
	args: { data: mockSentimentOverview(), sortKey: "negativeVisibility" },
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(q(canvasElement, "sentiment-leaderboard")).toBeTruthy());
		const names = [...canvasElement.querySelectorAll<HTMLElement>("[data-testid=sentiment-leaderboard-row]")].map(
			(row) => cellText(row, 2).replace(/\s*You$/, ""),
		);
		expect(names[0]).toBe("Charlie Cover");
		expect(cellText(rowFor(canvasElement, "Foxtrot Rechtsschutz"), 3)).toContain("50 · 2 mentions");
		expect(
			rowFor(canvasElement, "Foxtrot Rechtsschutz").querySelector('[role="img"]')?.getAttribute("aria-label"),
		).toBe("Positive 0, Neutral 0, Mixed 2, Negative 0");
	},
};

/** B4 — the Price view: sample-based score and visibility, no Partial cue for answers that skip Price. */
export const PriceAspect: Story = {
	args: { data: mockSentimentPriceAspect() },
	play: async ({ canvasElement }) => {
		const root = canvasElement;
		await waitFor(() => expect(q(root, "sentiment-leaderboard")).toBeTruthy());
		const a = rowFor(root, "Alpha Legal");
		expect(cellText(a, 3)).toContain("72 · 1 Price mention");
		expect(cellText(a, 3)).toContain("Low sample");
		expect(cellText(a, 3)).not.toContain("Partial");
		expect(cellText(a, 4)).toBe("10%");
		expect(cellText(a, 5)).toBe("10%");
		expect(cellText(a, 6)).toBe("0%");
		expect(cellText(a, 8)).toBe("100%");
		expect(a.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
			"Positive 1, Neutral 0, Mixed 0, Negative 0",
		);
		// Bravo is mentioned and classified but never discusses Price: a dash, 0 %, and still full coverage.
		const b = rowFor(root, "Bravo Protect");
		expect(cellText(b, 3)).toBe("— · 0 Price mentions");
		expect(cellText(b, 4)).toBe("0%");
		expect(cellText(b, 8)).toBe("100%");
		expect(root.querySelector("[data-testid=sentiment-coverage-note]")).toBeNull();
		expect(root.textContent).toContain("Price Mention Visibility");
		expect(q(root, "sentiment-headline").textContent).toBe("65");
		expect(q(root, "sentiment-headline-mentions").textContent).toContain("3 Price mentions");
		const legend = [...q(root, "sentiment-legend").querySelectorAll("li")].map((li) => li.textContent ?? "");
		expect(legend[0]).toContain("65 · 3 Price");
		// Roster order follows the Price sample (Charlie 2 before Alpha 1), never the mention count.
		expect(legend.map((text) => text.replace(/\d.*$/, "").trim())).toEqual([
			"Acme InsuranceYou",
			"Charlie Cover",
			"Alpha Legal",
		]);
	},
};

export const BrandOnly: Story = {
	args: { data: mockSentimentBrandOnly() },
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(q(canvasElement, "sentiment-leaderboard")).toBeTruthy());
		expect(canvasElement.querySelectorAll("[data-testid=sentiment-leaderboard-row]")).toHaveLength(1);
		expect(q(canvasElement, "sentiment-legend").querySelectorAll("li")).toHaveLength(1);
		expect(q(canvasElement, "sentiment-headline").textContent).toBe("82");
	},
};

/** Mentions found, classification pending or failed: dashes, no fabricated 50s, an explicit note. */
export const ClassificationPending: Story = {
	args: { data: mockSentimentPending() },
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(q(canvasElement, "sentiment-leaderboard")).toBeTruthy());
		expect(q(canvasElement, "sentiment-headline").textContent).toBe("—");
		expect(q(canvasElement, "sentiment-headline-mentions").textContent).toContain("0 of 9 analyzed mentions");
		expect(q(canvasElement, "sentiment-coverage-note").textContent).toContain(
			"Mention detection covers 7 of 12 responses",
		);
		expect(q(canvasElement, "sentiment-coverage-note").textContent).toContain("2 analyses failed");
		expect(q(canvasElement, "sentiment-trend").textContent).toContain("not produced classified mentions");
		expect(canvasElement.textContent).not.toMatch(/\b50\b · 0/);
	},
};

export const SparseAllTime: Story = {
	args: { data: mockSentimentSparse() },
	play: async ({ canvasElement }) => {
		await waitFor(() =>
			expect(
				q(canvasElement, "sentiment-trend").querySelectorAll("path.recharts-line-curve").length,
			).toBeGreaterThanOrEqual(2),
		);
		expect(q(canvasElement, "sentiment-headline-meta").textContent).toContain("October 3, 2025 – September 12, 2026");
	},
};

export const Empty: Story = {
	args: { data: mockSentimentEmpty() },
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(q(canvasElement, "sentiment-empty")).toBeTruthy());
		expect(canvasElement.querySelector("[data-testid=sentiment-leaderboard]")).toBeNull();
	},
};

export const Loading: Story = {
	args: { data: mockSentimentEmpty() },
	render: () => <SentimentSkeleton />,
	play: async ({ canvasElement }) => {
		expect(q(canvasElement, "sentiment-loading")).toBeTruthy();
	},
};

export const ErrorState: Story = {
	args: { data: mockSentimentEmpty() },
	render: () => <SentimentError onRetry={() => {}} />,
	play: async ({ canvasElement }) => {
		expect(q(canvasElement, "sentiment-error").textContent).toContain("Retry");
		expect(canvasElement.querySelector('[role="alert"]')).toBeTruthy();
		expect(SentimentEmpty).toBeTypeOf("function");
	},
};

/** ST-SNT-003 — an expanded row: 10 highest / 10 lowest, original sources, deep link, no model label. */
export const ExpandedEvidence: Story = {
	args: { data: mockSentimentOverview(), evidence: mockSentimentEvidence(), initiallyExpanded: "a" },
	play: async ({ canvasElement }) => {
		const root = canvasElement;
		await waitFor(() => expect(q(root, "sentiment-evidence")).toBeTruthy());
		expect(rowFor(root, "Alpha Legal").getAttribute("aria-expanded")).toBe("true");
		const highest = q(root, "sentiment-evidence-highest").querySelectorAll("[data-testid=sentiment-evidence-item]");
		const lowest = q(root, "sentiment-evidence-lowest").querySelectorAll("[data-testid=sentiment-evidence-item]");
		expect(highest).toHaveLength(10);
		expect(lowest).toHaveLength(10);
		const runs = new Set([...highest, ...lowest].map((el) => el.getAttribute("data-run")));
		expect(runs.size).toBe(20);
		expect(highest[0].textContent).toContain("100");
		expect(highest[0].textContent).toContain("Positive");
		expect(highest[0].querySelector("mark")?.textContent).toBe(FIXTURE_SPAN_1);
		expect(within(highest[0] as HTMLElement).getByTestId("sentiment-evidence-sources").textContent).toContain(
			"verbraucher.example",
		);
		expect(within(highest[1] as HTMLElement).getByTestId("sentiment-evidence-sources").textContent).toContain(
			"No cited sources",
		);
		expect(lowest[9].textContent).toContain("Mixed");
		expect(root.querySelectorAll("[data-testid=sentiment-evidence-deep-link]")).toHaveLength(20);
		expect(q(root, "sentiment-evidence").textContent).not.toMatch(/openrouter|gpt|chatgpt|version/i);
		// Only one row open at a time; clicking another row moves the panel.
		await userEvent.click(rowFor(root, "Charlie Cover"));
		await waitFor(() => expect(rowFor(root, "Charlie Cover").getAttribute("aria-expanded")).toBe("true"));
		expect(rowFor(root, "Alpha Legal").getAttribute("aria-expanded")).toBe("false");
		expect(root.querySelectorAll("[data-testid=sentiment-expanded]")).toHaveLength(1);
	},
};

export const ExpandedFewObservations: Story = {
	args: { data: mockSentimentOverview(), evidence: mockSentimentEvidenceFew(), initiallyExpanded: "b" },
	play: async ({ canvasElement }) => {
		await waitFor(() => expect(q(canvasElement, "sentiment-evidence")).toBeTruthy());
		expect(q(canvasElement, "sentiment-evidence-highest").textContent).toContain("Highest sentiment (2)");
		expect(q(canvasElement, "sentiment-evidence-lowest").textContent).toContain("Lowest sentiment (1)");
	},
};

/**
 * ST-SNT-EXC-001…004 — every stored span is rendered in full, whatever its
 * position: a single span is one excerpt; adjacent spans share one excerpt;
 * three distant spans give three numbered excerpts with a visible gap; a
 * Mixed verdict citing one anchor twice shows one mark carrying both
 * polarities. No card ever shows the whole answer.
 */
export const EvidenceShapes: Story = {
	args: { data: mockSentimentOverview(), evidence: mockSentimentEvidenceShapes(), initiallyExpanded: "a" },
	play: async ({ canvasElement }) => {
		const root = canvasElement;
		await waitFor(() => expect(q(root, "sentiment-evidence")).toBeTruthy());
		const items = [...root.querySelectorAll("[data-testid=sentiment-evidence-item]")] as HTMLElement[];
		const byRun = (run: string) => items.find((el) => el.getAttribute("data-run") === `run-${run}`) as HTMLElement;
		const marks = (el: HTMLElement) => [...el.querySelectorAll("mark")].map((m) => m.textContent);
		const groups = (el: HTMLElement) => el.querySelectorAll("[data-testid=sentiment-evidence-excerpt]");

		// single span → one excerpt, one mark, no numbering
		expect(groups(byRun("single"))).toHaveLength(1);
		expect(marks(byRun("single"))).toEqual([FIXTURE_SPAN_1]);
		expect(byRun("single").textContent).not.toContain("Evidence 1 of");

		// adjacent spans → one shared excerpt with two marks in reading order
		expect(groups(byRun("adjacent"))).toHaveLength(1);
		expect(marks(byRun("adjacent"))).toEqual([FIXTURE_SPAN_1, FIXTURE_ADJACENT]);

		// three distant spans → three numbered excerpts, every span in full, input order irrelevant
		const distant = byRun("distant");
		expect(groups(distant)).toHaveLength(3);
		expect(marks(distant)).toEqual([FIXTURE_SPAN_1, FIXTURE_SPAN_2, FIXTURE_SPAN_3]);
		expect(distant.textContent).toContain("Evidence 1 of 3");
		expect(distant.textContent).toContain("Evidence 3 of 3");
		expect((distant.textContent ?? "").length).toBeLessThan(FIXTURE_BODY.length);
		expect(distant.querySelector("mark[data-polarity=negative]")?.textContent).toBe(FIXTURE_SPAN_3);

		// Mixed on one anchor → one mark with both polarities
		const mixed = byRun("mixed-one-anchor");
		expect(marks(mixed)).toEqual([FIXTURE_SPAN_1]);
		expect(mixed.querySelector("mark")?.getAttribute("data-polarity")).toBe("positive,negative");

		// reading order of excerpts == DOM order == raw offset order (screen readers follow the list)
		const starts = [...groups(distant)].map((g) => Number(g.getAttribute("data-excerpt-start")));
		expect([...starts].sort((x, y) => x - y)).toEqual(starts);
		expect(root.querySelectorAll("[data-testid=sentiment-evidence-deep-link]")).toHaveLength(4);
		expect(q(root, "sentiment-evidence").textContent).not.toMatch(/openrouter|gpt|chatgpt|version/i);
	},
};

/** The same shapes in dark mode: marks stay legible on the dark surface. */
export const EvidenceShapesDark: Story = {
	...EvidenceShapes,
	decorators: [
		(Story) => (
			<div className="dark bg-background text-foreground p-6" style={{ width: 1200 }}>
				<Story />
			</div>
		),
	],
};

/** The same shapes at 375 px: excerpts stack, nothing overflows horizontally. */
export const EvidenceShapesNarrow: Story = {
	...EvidenceShapes,
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-2" style={{ width: 375 }}>
				<Story />
			</div>
		),
	],
	play: async (context) => {
		await EvidenceShapes.play?.(context);
		const root = context.canvasElement;
		expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
	},
};
