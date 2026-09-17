import type { SentimentAspectKey, SentimentCandidate, SentimentCategory } from "../types";
import { GOLDEN_BELTRA, GOLDEN_BRAND } from "./corpus";

/**
 * Classifier v4 golden cases: sanitised, synthetic reproducers of every failure
 * family the v3 production audit proved (entity swap, foreign-only evidence,
 * entity-unbound aspects, descriptive statistics read as praise, ambivalent
 * value/deductible statements, comparison tables, multi-entity sentences,
 * both-sides anchors, cross-aspect polarities, continuation and list context).
 * Fictional insurers only (Arvo, Beltra). Each case carries the wire-shaped
 * result the provider would have to return, the human-labelled expectation
 * per entity (overall category, aspect categories, aspects that must not
 * appear), the anchor ids each entity may and may not cite, and the validator
 * outcome. Offline and deterministic; nothing here is ever sent to a provider.
 */
export type GoldenV4Family =
	| "entity-swap"
	| "foreign-only"
	| "unbound-aspect"
	| "neutral-statistic"
	| "value-deductible-caveat"
	| "table"
	| "multi-entity"
	| "same-anchor-mixed"
	| "cross-aspect"
	| "continuation"
	| "list-intro";

export interface GoldenV4Expectation {
	category: SentimentCategory;
	aspects?: Partial<Record<SentimentAspectKey, { category: SentimentCategory }>>;
	/** Aspect keys the labelling must not contain (no explicit evaluation in the answer). */
	forbiddenAspects?: SentimentAspectKey[];
}

export interface GoldenV4Grounding {
	allowedAnchors: string[];
	forbiddenAnchors: string[];
}

export interface GoldenV4Case {
	id: string;
	lang: "de" | "en";
	family: GoldenV4Family;
	answer: string;
	candidates: SentimentCandidate[];
	/** The provider's answer in the v4 wire shape. */
	result: unknown;
	expected: Record<string, GoldenV4Expectation>;
	grounding: Record<string, GoldenV4Grounding>;
	expectedValidator: { kind: "accept" } | { kind: "reject"; code: string };
}

const ARVO = GOLDEN_BRAND.key;
const BELTRA = GOLDEN_BELTRA.key;
const both = [GOLDEN_BRAND, GOLDEN_BELTRA];

const cite = (polarity: "positive" | "negative" | "neutral", ...anchorIds: string[]) =>
	anchorIds.map((anchorId) => ({ anchorId, polarity }));
const positive = (score: number, ...anchorIds: string[]) => ({
	category: "positive",
	score,
	confidence: 0.9,
	evidence: cite("positive", ...anchorIds),
});
const negative = (score: number, ...anchorIds: string[]) => ({
	category: "negative",
	score,
	confidence: 0.9,
	evidence: cite("negative", ...anchorIds),
});
const neutral = (...anchorIds: string[]) => ({
	category: "neutral",
	score: 50,
	confidence: 0.9,
	evidence: cite("neutral", ...anchorIds),
});
const mixed = (positiveIds: string[], negativeIds: string[]) => ({
	category: "mixed",
	score: 50,
	confidence: 0.9,
	positiveEvidence: cite("positive", ...positiveIds),
	negativeEvidence: cite("negative", ...negativeIds),
});

export const GOLDEN_V4_CASES: GoldenV4Case[] = [
	{
		id: "v4-swap-de",
		lang: "de",
		family: "entity-swap",
		// s0001 Beltra sentence · s0002 table header · s0003 Beltra row · s0004 Arvo row
		answer:
			"Für Deutschland ist derzeit die Beltra Optimal der stärkste Kandidat beim Preis-Leistungs-Verhältnis.\n\n| Tarif | Geeignet für | Besonderheit |\n|---|---|---|\n| Beltra Optimal | Preisbewusste Singles | Bestes Preis-Leistungs-Verhältnis |\n| Arvo Komfort | Wer umfangreiche Leistungen möchte | Etwas teurer, dafür starke Zusatzleistungen |",
		candidates: both,
		result: {
			entities: [
				{ key: ARVO, ...positive(80, "s0001", "s0003"), aspects: [] },
				{ key: BELTRA, ...mixed(["s0004"], ["s0004"]), aspects: [] },
			],
		},
		expected: { [ARVO]: { category: "mixed" }, [BELTRA]: { category: "positive" } },
		grounding: {
			[ARVO]: { allowedAnchors: ["s0004", "s0002"], forbiddenAnchors: ["s0001", "s0003"] },
			[BELTRA]: { allowedAnchors: ["s0001", "s0003", "s0002"], forbiddenAnchors: ["s0004"] },
		},
		expectedValidator: { kind: "reject", code: "evidence-entity-unbound" },
	},
	{
		id: "v4-foreign-only-en",
		lang: "en",
		family: "foreign-only",
		answer: "Arvo offers a solid service.\n\nBeltra is cheap.",
		candidates: both,
		result: {
			entities: [
				{ key: ARVO, ...positive(75, "s0002"), aspects: [] },
				{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
			],
		},
		expected: { [ARVO]: { category: "positive" }, [BELTRA]: { category: "positive" } },
		grounding: {
			[ARVO]: { allowedAnchors: ["s0001"], forbiddenAnchors: ["s0002"] },
			[BELTRA]: { allowedAnchors: ["s0002"], forbiddenAnchors: ["s0001"] },
		},
		expectedValidator: { kind: "reject", code: "evidence-entity-unbound" },
	},
	{
		id: "v4-checklist-de",
		lang: "de",
		family: "unbound-aspect",
		// s0001 Arvo sentence · s0002 intro without an entity · s0003/s0004 generic bullets
		answer: "Arvo kann gut sein.\n\nAchte vor Abschluss besonders auf:\n- Beitragserhöhungen\n- Selbstbeteiligung",
		candidates: [GOLDEN_BRAND],
		result: {
			entities: [
				{
					key: ARVO,
					...positive(70, "s0001"),
					aspects: [{ key: "price", ...negative(25, "s0003", "s0004") }],
				},
			],
		},
		expected: { [ARVO]: { category: "positive", forbiddenAspects: ["price", "other"] } },
		grounding: { [ARVO]: { allowedAnchors: ["s0001"], forbiddenAnchors: ["s0002", "s0003", "s0004"] } },
		expectedValidator: { kind: "reject", code: "aspect-ungrounded" },
	},
	{
		id: "v4-stat-cases-de",
		lang: "de",
		family: "neutral-statistic",
		// s0001 report sentence · s0002 intro · s0003 Arvo case-count statistic · s0004 generic statistic
		answer:
			"Der Arvo Trendmonitor analysiert Rechtskonflikte in Deutschland.\n\nDie wichtigsten Ergebnisse:\n- Arbeitsrecht: Die Fälle bei Arvo stiegen seit 2021 um 63 %.\n- Mietrecht: Die Fälle nahmen um 74 % zu.",
		candidates: [GOLDEN_BRAND],
		result: { entities: [{ key: ARVO, ...neutral("s0001", "s0003"), aspects: [] }] },
		expected: { [ARVO]: { category: "neutral", forbiddenAspects: ["other", "coverage", "service", "price"] } },
		grounding: { [ARVO]: { allowedAnchors: ["s0001", "s0003", "s0004"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-stat-usage-de",
		lang: "de",
		family: "neutral-statistic",
		answer:
			"Arvo berichtet über den digitalen Zugang zum Recht.\n\nDie Nutzung der digitalen Arvo-Rechtsservices stieg 2025 um 35 %.",
		candidates: [GOLDEN_BRAND],
		result: { entities: [{ key: ARVO, ...neutral("s0001", "s0002"), aspects: [] }] },
		expected: { [ARVO]: { category: "neutral", forbiddenAspects: ["service", "other"] } },
		grounding: { [ARVO]: { allowedAnchors: ["s0001", "s0002"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-huk-caveat-de",
		lang: "de",
		family: "value-deductible-caveat",
		// s0001 Arvo sentence · s0002 Beltra value + deductible caveat
		answer:
			"Arvo Komfort bietet umfangreiche Leistungen.\n\nBeltra Plus – gute Leistungen zu einem günstigen Beitrag, aber die Selbstbeteiligung kann nach mehreren Schadenfällen auf 550 Euro steigen.",
		candidates: both,
		result: {
			entities: [
				{ key: ARVO, ...positive(80, "s0001"), aspects: [{ key: "coverage", ...positive(80, "s0001") }] },
				{
					key: BELTRA,
					...mixed(["s0002"], ["s0002"]),
					aspects: [
						{ key: "price", ...mixed(["s0002"], ["s0002"]) },
						{ key: "coverage", ...positive(75, "s0002") },
					],
				},
			],
		},
		expected: {
			[ARVO]: { category: "positive", aspects: { coverage: { category: "positive" } }, forbiddenAspects: ["other"] },
			[BELTRA]: {
				category: "mixed",
				aspects: { price: { category: "mixed" }, coverage: { category: "positive" } },
				forbiddenAspects: ["other"],
			},
		},
		grounding: {
			[ARVO]: { allowedAnchors: ["s0001"], forbiddenAnchors: ["s0002"] },
			[BELTRA]: { allowedAnchors: ["s0002"], forbiddenAnchors: ["s0001"] },
		},
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-table-en",
		lang: "en",
		family: "table",
		// s0001 intro · s0002 header row · s0003 price row · s0004 coverage row · s0005 verdict
		answer:
			"Comparison of the two legal insurers:\n\n| Criterion | Arvo | Beltra |\n|---|---|---|\n| Price | Usually more expensive | Often cheaper |\n| Coverage | Very broad modular cover | Solid standard cover |\n\nOverall Arvo is the stronger choice if you want breadth.",
		candidates: both,
		result: {
			entities: [
				{
					key: ARVO,
					...mixed(["s0004", "s0005"], ["s0003"]),
					aspects: [
						{ key: "price", ...negative(30, "s0003") },
						{ key: "coverage", ...positive(85, "s0004") },
					],
				},
				{
					key: BELTRA,
					...positive(70, "s0003", "s0004"),
					aspects: [
						{ key: "price", ...positive(75, "s0003") },
						{ key: "coverage", ...positive(65, "s0004") },
					],
				},
			],
		},
		expected: {
			[ARVO]: { category: "mixed", aspects: { price: { category: "negative" }, coverage: { category: "positive" } } },
			[BELTRA]: {
				category: "positive",
				aspects: { price: { category: "positive" }, coverage: { category: "positive" } },
			},
		},
		grounding: {
			[ARVO]: { allowedAnchors: ["s0002", "s0003", "s0004", "s0005"], forbiddenAnchors: [] },
			[BELTRA]: { allowedAnchors: ["s0002", "s0003", "s0004"], forbiddenAnchors: ["s0005"] },
		},
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-multi-entity-de",
		lang: "de",
		family: "multi-entity",
		answer: "Arvo und Beltra bieten beide eine unbegrenzte Versicherungssumme in Europa.",
		candidates: both,
		result: {
			entities: [
				{ key: ARVO, ...positive(70, "s0001"), aspects: [{ key: "coverage", ...positive(70, "s0001") }] },
				{ key: BELTRA, ...positive(70, "s0001"), aspects: [{ key: "coverage", ...positive(70, "s0001") }] },
			],
		},
		expected: {
			[ARVO]: { category: "positive", aspects: { coverage: { category: "positive" } } },
			[BELTRA]: { category: "positive", aspects: { coverage: { category: "positive" } } },
		},
		grounding: {
			[ARVO]: { allowedAnchors: ["s0001"], forbiddenAnchors: [] },
			[BELTRA]: { allowedAnchors: ["s0001"], forbiddenAnchors: [] },
		},
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-same-anchor-mixed-de",
		lang: "de",
		family: "same-anchor-mixed",
		answer: "Arvo ist preiswert, aber der Service ist langsam.",
		candidates: [GOLDEN_BRAND],
		result: {
			entities: [
				{
					key: ARVO,
					...mixed(["s0001"], ["s0001"]),
					aspects: [
						{ key: "price", ...positive(75, "s0001") },
						{ key: "service", ...negative(25, "s0001") },
					],
				},
			],
		},
		expected: {
			[ARVO]: { category: "mixed", aspects: { price: { category: "positive" }, service: { category: "negative" } } },
		},
		grounding: { [ARVO]: { allowedAnchors: ["s0001"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-cross-aspect-en",
		lang: "en",
		family: "cross-aspect",
		answer: "Arvo has very broad coverage.\n\nArvo is expensive.",
		candidates: [GOLDEN_BRAND],
		result: {
			entities: [
				{
					key: ARVO,
					...mixed(["s0001"], ["s0002"]),
					aspects: [
						{ key: "coverage", ...positive(80, "s0001") },
						{ key: "price", ...negative(25, "s0002") },
					],
				},
			],
		},
		expected: {
			[ARVO]: { category: "mixed", aspects: { coverage: { category: "positive" }, price: { category: "negative" } } },
		},
		grounding: { [ARVO]: { allowedAnchors: ["s0001", "s0002"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-continuation-de",
		lang: "de",
		family: "continuation",
		// s0001 names Arvo · s0002 continues the same paragraph without naming it
		answer:
			"Arvo bietet drei Tarifstufen an. Die Premium-Variante enthält zusätzliche Leistungen wie erweiterten Strafrechtsschutz.",
		candidates: [GOLDEN_BRAND],
		result: {
			entities: [{ key: ARVO, ...positive(70, "s0002"), aspects: [{ key: "coverage", ...positive(70, "s0002") }] }],
		},
		expected: { [ARVO]: { category: "positive", aspects: { coverage: { category: "positive" } } } },
		grounding: { [ARVO]: { allowedAnchors: ["s0001", "s0002"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
	{
		id: "v4-list-intro-de",
		lang: "de",
		family: "list-intro",
		// s0001 colon-terminated intro naming Arvo · s0002/s0003 list items about it
		answer:
			"Wenn du Arvo Mietrechtsschutz Sofort meinst:\n\n- Schutz ohne Wartezeit ab Vertragsbeginn.\n- Ein bereits bestehender Streit ist nicht automatisch vollständig versichert.",
		candidates: [GOLDEN_BRAND],
		result: {
			entities: [
				{
					key: ARVO,
					...mixed(["s0002"], ["s0003"]),
					aspects: [{ key: "coverage", ...mixed(["s0002"], ["s0003"]) }],
				},
			],
		},
		expected: { [ARVO]: { category: "mixed", aspects: { coverage: { category: "mixed" } } } },
		grounding: { [ARVO]: { allowedAnchors: ["s0001", "s0002", "s0003"], forbiddenAnchors: [] } },
		expectedValidator: { kind: "accept" },
	},
];
