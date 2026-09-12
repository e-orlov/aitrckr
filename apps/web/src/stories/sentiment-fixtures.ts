import { computeEntityMetrics, LOW_SAMPLE_THRESHOLD } from "@workspace/lib/sentiment/metrics";
import type {
	SentimentEntityRow,
	SentimentEvidenceItem,
	SentimentEvidenceResponse,
	SentimentOverviewResponse,
} from "@/server/sentiment";

/**
 * Synthetic Sentiment fixtures for Storybook. The canonical acceptance fixture
 * (T = 10; A: 100P 80P 50 Mixed 40N 30N → 60 / 50 % / 20 % / 20 %; B: one 90P →
 * 90 / 10 %) sits in the default story so the exact labels are asserted.
 */
type Counts = { positive: number; neutral: number; mixed: number; negative: number };

export function entityRow(args: {
	key: string;
	name: string;
	isBrand?: boolean;
	eligible: number;
	mentions: number;
	classified: number;
	counts?: Partial<Counts>;
	scoreSum?: number;
}): SentimentEntityRow {
	const counts: Counts = { positive: 0, neutral: 0, mixed: 0, negative: 0, ...args.counts };
	return {
		key: args.key,
		entityType: args.isBrand ? "brand" : "competitor",
		competitorId: args.isBrand ? null : args.key,
		name: args.name,
		isBrand: args.isBrand === true,
		mentions: args.mentions,
		classified: args.classified,
		counts,
		metrics: computeEntityMetrics({
			eligibleResponses: args.eligible,
			mentions: args.mentions,
			classified: args.classified,
			...counts,
			scoreSum: args.scoreSum ?? 0,
		}),
		lowSample: args.classified > 0 && args.classified < LOW_SAMPLE_THRESHOLD,
	};
}

export const DATES_20 = Array.from({ length: 20 }, (_, i) => `2026-08-${String(i + 8).padStart(2, "0")}`);

function series(roster: string[], values: Record<string, (number | null)[]>): SentimentOverviewResponse["series"] {
	return DATES_20.map((bucketStart, i) => ({
		bucketStart,
		values: Object.fromEntries(
			roster.map((key) => {
				const v = values[key]?.[i] ?? null;
				return [key, { sentiment: v, classified: v === null ? 0 : 1 + (i % 3) }];
			}),
		),
	}));
}

const base = (over: Partial<SentimentOverviewResponse>): SentimentOverviewResponse => ({
	brand: { id: "mock-brand-id", name: "Acme Insurance" },
	dateRange: { fromDate: DATES_20[0], toDate: DATES_20[DATES_20.length - 1], timezone: "UTC" },
	aspect: "overall",
	availableAspects: [
		{ key: "price", label: "Price", count: 4 },
		{ key: "coverage", label: "Coverage", count: 2 },
		{ key: "service", label: "Service", count: 3 },
		{ key: "other", label: "Other", count: 0 },
	],
	eligibleResponses: 10,
	coverage: {
		responsesDetected: 10,
		responsesWithMentions: 8,
		analyses: { completed: 8, pending: 0, failed: 0, noMentions: 2 },
	},
	entities: [],
	chartRoster: ["brand"],
	bucket: "day",
	series: [],
	...over,
});

/** Canonical fixture + a full roster: brand, A (the acceptance entity), B (one mention), plus five more and a zero-mention row. */
export function mockSentimentOverview(): SentimentOverviewResponse {
	const T = 10;
	const entities = [
		entityRow({
			key: "brand",
			name: "Acme Insurance",
			isBrand: true,
			eligible: T,
			mentions: 8,
			classified: 8,
			counts: { positive: 6, neutral: 1, negative: 1 },
			scoreSum: 80 * 6 + 50 + 30,
		}),
		entityRow({
			key: "a",
			name: "Alpha Legal",
			eligible: T,
			mentions: 5,
			classified: 5,
			counts: { positive: 2, mixed: 1, negative: 2 },
			scoreSum: 100 + 80 + 50 + 40 + 30,
		}),
		entityRow({
			key: "b",
			name: "Bravo Protect",
			eligible: T,
			mentions: 1,
			classified: 1,
			counts: { positive: 1 },
			scoreSum: 90,
		}),
		entityRow({
			key: "c",
			name: "Charlie Cover",
			eligible: T,
			mentions: 4,
			classified: 4,
			counts: { negative: 3, neutral: 1 },
			scoreSum: 20 + 25 + 35 + 50,
		}),
		entityRow({
			key: "d",
			name: "Delta Direct",
			eligible: T,
			mentions: 3,
			classified: 3,
			counts: { neutral: 3 },
			scoreSum: 150,
		}),
		entityRow({
			key: "e",
			name: "Echo Assurance",
			eligible: T,
			mentions: 3,
			classified: 2,
			counts: { positive: 2 },
			scoreSum: 70 + 75,
		}),
		entityRow({
			key: "f",
			name: "Foxtrot Rechtsschutz",
			eligible: T,
			mentions: 2,
			classified: 2,
			counts: { mixed: 2 },
			scoreSum: 100,
		}),
		entityRow({
			key: "g",
			name: "Golf Versicherung",
			eligible: T,
			mentions: 2,
			classified: 2,
			counts: { positive: 1, negative: 1 },
			scoreSum: 60 + 45,
		}),
		entityRow({ key: "z", name: "Zero Mentions GmbH", eligible: T, mentions: 0, classified: 0 }),
	];
	const roster = ["brand", "a", "c", "d", "e", "f", "g"];
	return base({
		entities,
		chartRoster: roster,
		coverage: {
			responsesDetected: 10,
			responsesWithMentions: 9,
			analyses: { completed: 8, pending: 1, failed: 0, noMentions: 1 },
		},
		series: series(roster, {
			brand: [72, 70, null, 74, 78, 80, 76, null, 82, 79, 77, 80, 84, 81, 79, 78, 80, 83, 85, 82],
			a: [40, null, 55, 60, 62, null, null, 58, 61, 64, 60, 59, 57, 60, 62, 65, 63, 60, 58, 60],
			c: [30, 28, 32, null, 27, 30, 33, 31, 29, null, null, 30, 32, 28, 26, 30, 31, 29, 30, 33],
			d: [50, 50, 50, 50, null, 50, 50, 50, 50, 50, 50, 50, 50, null, 50, 50, 50, 50, 50, 50],
			e: [null, null, 70, 72, 74, 71, 73, null, null, 75, 72, 70, 71, 74, 76, 73, 72, 70, 71, 74],
			f: [50, null, null, 50, 50, null, 50, 50, null, 50, 50, 50, null, 50, 50, 50, 50, null, 50, 50],
			g: [null, 55, 52, 50, 48, 53, 55, 57, 52, 51, 49, 54, 56, 52, 50, 53, 55, 54, 52, 51],
		}),
	});
}

/** Brand-only roster (no competitors configured). */
export function mockSentimentBrandOnly(): SentimentOverviewResponse {
	return base({
		entities: [
			entityRow({
				key: "brand",
				name: "Acme Insurance",
				isBrand: true,
				eligible: 6,
				mentions: 6,
				classified: 6,
				counts: { positive: 5, mixed: 1 },
				scoreSum: 88 * 5 + 50,
			}),
		],
		eligibleResponses: 6,
		coverage: {
			responsesDetected: 6,
			responsesWithMentions: 6,
			analyses: { completed: 6, pending: 0, failed: 0, noMentions: 0 },
		},
		series: series(["brand"], {
			brand: [85, 88, null, 90, 86, 84, 88, 90, 91, 87, 86, 88, 89, 90, 88, 87, 85, 88, 90, 89],
		}),
	});
}

/** Mentions detected but nothing classified yet (backfill pending) plus one failed analysis. */
export function mockSentimentPending(): SentimentOverviewResponse {
	return base({
		entities: [
			entityRow({ key: "brand", name: "Acme Insurance", isBrand: true, eligible: 12, mentions: 9, classified: 0 }),
			entityRow({ key: "a", name: "Alpha Legal", eligible: 12, mentions: 4, classified: 0 }),
		],
		chartRoster: ["brand", "a"],
		eligibleResponses: 12,
		coverage: {
			responsesDetected: 7,
			responsesWithMentions: 7,
			analyses: { completed: 0, pending: 5, failed: 2, noMentions: 0 },
		},
		series: series(["brand", "a"], {}),
	});
}

/** No stored responses at all. */
export function mockSentimentEmpty(): SentimentOverviewResponse {
	return base({
		eligibleResponses: 0,
		coverage: {
			responsesDetected: 0,
			responsesWithMentions: 0,
			analyses: { completed: 0, pending: 0, failed: 0, noMentions: 0 },
		},
	});
}

/** Sparse all-time history in monthly buckets. */
export function mockSentimentSparse(): SentimentOverviewResponse {
	const months = [
		"2025-10-01",
		"2025-11-01",
		"2025-12-01",
		"2026-01-01",
		"2026-02-01",
		"2026-03-01",
		"2026-04-01",
		"2026-05-01",
		"2026-06-01",
		"2026-07-01",
		"2026-08-01",
		"2026-09-01",
	];
	const brand = [null, 60, null, null, 72, null, 68, null, null, 75, 70, 71];
	return base({
		dateRange: { fromDate: "2025-10-03", toDate: "2026-09-12", timezone: "UTC" },
		bucket: "month",
		eligibleResponses: 41,
		entities: [
			entityRow({
				key: "brand",
				name: "Acme Insurance",
				isBrand: true,
				eligible: 41,
				mentions: 14,
				classified: 14,
				counts: { positive: 10, neutral: 2, mixed: 1, negative: 1 },
				scoreSum: 980,
			}),
			entityRow({
				key: "a",
				name: "Alpha Legal",
				eligible: 41,
				mentions: 3,
				classified: 3,
				counts: { negative: 3 },
				scoreSum: 90,
			}),
		],
		chartRoster: ["brand", "a"],
		coverage: {
			responsesDetected: 41,
			responsesWithMentions: 15,
			analyses: { completed: 15, pending: 0, failed: 0, noMentions: 26 },
		},
		series: months.map((bucketStart, i) => ({
			bucketStart,
			values: {
				brand: { sentiment: brand[i], classified: brand[i] === null ? 0 : 2 },
				a: { sentiment: i === 4 ? 30 : null, classified: i === 4 ? 3 : 0 },
			},
		})),
	});
}

const item = (args: {
	id: string;
	score: number;
	category: SentimentEvidenceItem["category"];
	withSources?: boolean;
	aspects?: SentimentEvidenceItem["aspects"];
}): SentimentEvidenceItem => ({
	observationId: `obs-${args.id}`,
	promptRunId: `run-${args.id}`,
	promptId: "prompt-1",
	promptText: "Welche Rechtsschutzversicherung ist für Familien am besten?",
	tags: ["insurance", "families"],
	runCreatedAt: "2026-08-20T10:00:00.000Z",
	score: args.score,
	category: args.category,
	evidence: [{ quote: "Alpha Legal reguliert Schäden schnell", start: 0, end: 10 }],
	excerpt:
		"…Im Vergleich der Anbieter fällt auf: Alpha Legal reguliert Schäden schnell, verlangt aber überdurchschnittliche Beiträge. Für Familien lohnt sich der Blick auf den Leistungsumfang…",
	aspects: args.aspects ?? [{ key: "service", label: "Service", score: 82, category: "positive" }],
	sources: args.withSources
		? [
				{ url: "https://verbraucher.example/test", domain: "verbraucher.example", title: "Test 2026" },
				{ url: "https://vergleich.example/rs", domain: "vergleich.example", title: null },
			]
		: [],
});

/** 10 highest / 10 lowest, non-overlapping, first item with two original sources. */
export function mockSentimentEvidence(): SentimentEvidenceResponse {
	const highest = [100, 95, 90, 85, 80, 78, 75, 72, 70, 68].map((score, i) =>
		item({ id: `h${i}`, score, category: "positive", withSources: i === 0 }),
	);
	const lowest = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((score, i) =>
		item({
			id: `l${i}`,
			score,
			category: score === 50 ? "mixed" : "negative",
			aspects: [{ key: "price", label: "Price", score: 30, category: "negative" }],
		}),
	);
	return { entity: { key: "a", name: "Alpha Legal" }, aspect: "overall", totalObservations: 24, highest, lowest };
}

/** Fewer than twenty observations: the extremes share the records without duplicating any. */
export function mockSentimentEvidenceFew(): SentimentEvidenceResponse {
	return {
		entity: { key: "b", name: "Bravo Protect" },
		aspect: "overall",
		totalObservations: 3,
		highest: [item({ id: "x1", score: 90, category: "positive" }), item({ id: "x2", score: 60, category: "positive" })],
		lowest: [item({ id: "x3", score: 20, category: "negative" })],
	};
}
