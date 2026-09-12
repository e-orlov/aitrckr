import type { SentimentAspectKey, SentimentCandidate, SentimentCategory } from "../types";

/**
 * Synthetic, hand-labelled corpus for the sentiment classifier contract. No
 * production answer text: every answer is invented for a fictional legal-
 * insurance market with the tracked brand "Arvo" and competitors "Beltra",
 * "Corvex" and "Dunhill Schutz" (alias "Dunhill"). Each case carries the
 * expected category per entity with a score range and, where the answer
 * evaluates them, aspect categories; `reference` is a fully labelled answer
 * that must pass the classifier validation verbatim.
 */
export interface GoldenAspectExpectation {
	category: SentimentCategory;
}

export interface GoldenEntityExpectation {
	category: SentimentCategory;
	/** Inclusive score range the labelled score must fall into. */
	scoreRange: [number, number];
	aspects?: Partial<Record<SentimentAspectKey, GoldenAspectExpectation>>;
}

export interface GoldenReferenceAspect {
	key: SentimentAspectKey;
	score: number;
	category: SentimentCategory;
	confidence: number;
	evidence: { quote: string }[];
}

export interface GoldenReferenceEntity {
	key: string;
	score: number;
	category: SentimentCategory;
	confidence: number;
	evidence: { quote: string }[];
	aspects: GoldenReferenceAspect[];
}

export interface GoldenCase {
	id: string;
	lang: "de" | "en";
	/** Must-pass cases (negation, comparison, attribution) gate at 100 %. */
	critical?: boolean;
	answer: string;
	candidates: SentimentCandidate[];
	expected: Record<string, GoldenEntityExpectation>;
	reference: { entities: GoldenReferenceEntity[] };
}

export const GOLDEN_BRAND: SentimentCandidate = {
	key: "brand",
	entityType: "brand",
	competitorId: null,
	name: "Arvo",
	aliases: ["Arvo Rechtsschutz"],
};
export const GOLDEN_BELTRA: SentimentCandidate = {
	key: "c-beltra",
	entityType: "competitor",
	competitorId: "c-beltra",
	name: "Beltra",
	aliases: [],
};
export const GOLDEN_CORVEX: SentimentCandidate = {
	key: "c-corvex",
	entityType: "competitor",
	competitorId: "c-corvex",
	name: "Corvex",
	aliases: [],
};
export const GOLDEN_DUNHILL: SentimentCandidate = {
	key: "c-dunhill",
	entityType: "competitor",
	competitorId: "c-dunhill",
	name: "Dunhill Schutz",
	aliases: ["Dunhill"],
};

const e = (
	key: string,
	score: number,
	category: SentimentCategory,
	evidence: string[],
	aspects: GoldenReferenceAspect[] = [],
	confidence = 0.9,
): GoldenReferenceEntity => ({
	key,
	score,
	category,
	confidence,
	evidence: evidence.map((quote) => ({ quote })),
	aspects,
});

const a = (
	key: SentimentAspectKey,
	score: number,
	category: SentimentCategory,
	evidence: string[],
	confidence = 0.85,
): GoldenReferenceAspect => ({
	key,
	score,
	category,
	confidence,
	evidence: evidence.map((quote) => ({ quote })),
});

export const GOLDEN_CASES: GoldenCase[] = [
	{
		id: "g01-factual-de",
		lang: "de",
		answer:
			"Arvo ist ein deutscher Rechtsschutzversicherer mit Sitz in Hamburg und bietet Privat- und Verkehrsrechtsschutz an.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "neutral", scoreRange: [50, 50] } },
		reference: {
			entities: [e("brand", 50, "neutral", ["Arvo ist ein deutscher Rechtsschutzversicherer mit Sitz in Hamburg"])],
		},
	},
	{
		id: "g02-recommendation-de",
		lang: "de",
		answer: "Für Familien empfehle ich klar Arvo: der Tarif ist umfassend und der Kundenservice reagiert schnell.",
		candidates: [GOLDEN_BRAND],
		expected: {
			brand: {
				category: "positive",
				scoreRange: [70, 100],
				aspects: { coverage: { category: "positive" }, service: { category: "positive" } },
			},
		},
		reference: {
			entities: [
				e(
					"brand",
					85,
					"positive",
					["empfehle ich klar Arvo"],
					[
						a("coverage", 80, "positive", ["der Tarif ist umfassend"]),
						a("service", 85, "positive", ["der Kundenservice reagiert schnell"]),
					],
				),
			],
		},
	},
	{
		id: "g03-warning-de",
		lang: "de",
		critical: true,
		answer: "Von Beltra würde ich abraten: lange Wartezeiten und viele Ausschlüsse im Kleingedruckten.",
		candidates: [GOLDEN_BELTRA],
		expected: {
			"c-beltra": { category: "negative", scoreRange: [0, 35], aspects: { coverage: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"c-beltra",
					20,
					"negative",
					["Von Beltra würde ich abraten"],
					[a("coverage", 25, "negative", ["viele Ausschlüsse im Kleingedruckten"])],
				),
			],
		},
	},
	{
		id: "g04-mixed-de",
		lang: "de",
		answer: "Corvex ist günstig, allerdings ist die Schadenabwicklung langsam und die Hotline schwer erreichbar.",
		candidates: [GOLDEN_CORVEX],
		expected: {
			"c-corvex": {
				category: "mixed",
				scoreRange: [50, 50],
				aspects: { price: { category: "positive" }, service: { category: "negative" } },
			},
		},
		reference: {
			entities: [
				e(
					"c-corvex",
					50,
					"mixed",
					["Corvex ist günstig", "die Schadenabwicklung langsam"],
					[
						a("price", 75, "positive", ["Corvex ist günstig"]),
						a("service", 25, "negative", ["die Hotline schwer erreichbar"]),
					],
				),
			],
		},
	},
	{
		id: "g05-not-expensive-de",
		lang: "de",
		critical: true,
		answer: "Arvo ist nicht teuer – für den Leistungsumfang sogar ein fairer Preis.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [60, 90], aspects: { price: { category: "positive" } } } },
		reference: {
			entities: [
				e("brand", 72, "positive", ["Arvo ist nicht teuer"], [a("price", 75, "positive", ["ein fairer Preis"])]),
			],
		},
	},
	{
		id: "g06-double-negation-en",
		lang: "en",
		critical: true,
		answer:
			"It is not true that Dunhill Schutz has no weaknesses: the claims process is slow and the premiums are above average.",
		candidates: [GOLDEN_DUNHILL],
		expected: {
			"c-dunhill": {
				category: "negative",
				scoreRange: [10, 45],
				aspects: { service: { category: "negative" }, price: { category: "negative" } },
			},
		},
		reference: {
			entities: [
				e(
					"c-dunhill",
					30,
					"negative",
					["the claims process is slow and the premiums are above average"],
					[
						a("service", 30, "negative", ["the claims process is slow"]),
						a("price", 30, "negative", ["the premiums are above average"]),
					],
				),
			],
		},
	},
	{
		id: "g07-comparison-en",
		lang: "en",
		critical: true,
		answer: "Arvo is clearly better than Beltra when it comes to coverage: Beltra excludes traffic disputes entirely.",
		candidates: [GOLDEN_BRAND, GOLDEN_BELTRA],
		expected: {
			brand: { category: "positive", scoreRange: [60, 95], aspects: { coverage: { category: "positive" } } },
			"c-beltra": { category: "negative", scoreRange: [10, 45], aspects: { coverage: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"brand",
					75,
					"positive",
					["Arvo is clearly better than Beltra when it comes to coverage"],
					[a("coverage", 78, "positive", ["Arvo is clearly better than Beltra when it comes to coverage"])],
				),
				e(
					"c-beltra",
					30,
					"negative",
					["Beltra excludes traffic disputes entirely"],
					[a("coverage", 25, "negative", ["Beltra excludes traffic disputes entirely"])],
				),
			],
		},
	},
	{
		id: "g08-plain-comparison-de",
		lang: "de",
		critical: true,
		answer: "Arvo und Corvex bieten beide einen Privatrechtsschutz mit 300 Euro Selbstbeteiligung an.",
		candidates: [GOLDEN_BRAND, GOLDEN_CORVEX],
		expected: {
			brand: { category: "neutral", scoreRange: [50, 50] },
			"c-corvex": { category: "neutral", scoreRange: [50, 50] },
		},
		reference: {
			entities: [
				e("brand", 50, "neutral", ["Arvo und Corvex bieten beide einen Privatrechtsschutz"]),
				e("c-corvex", 50, "neutral", ["Arvo und Corvex bieten beide einen Privatrechtsschutz"]),
			],
		},
	},
	{
		id: "g09-industry-negative-de",
		lang: "de",
		critical: true,
		answer:
			"Rechtsschutzversicherungen zahlen generell nicht bei Streitigkeiten, die vor Vertragsbeginn entstanden sind. Anbieter sind zum Beispiel Arvo und Dunhill.",
		candidates: [GOLDEN_BRAND, GOLDEN_DUNHILL],
		expected: {
			brand: { category: "neutral", scoreRange: [50, 50] },
			"c-dunhill": { category: "neutral", scoreRange: [50, 50] },
		},
		reference: {
			entities: [
				e("brand", 50, "neutral", ["Anbieter sind zum Beispiel Arvo und Dunhill"]),
				e("c-dunhill", 50, "neutral", ["Anbieter sind zum Beispiel Arvo und Dunhill"]),
			],
		},
	},
	{
		id: "g10-cited-opinion-en",
		lang: "en",
		critical: true,
		answer:
			"Some review sites rate Beltra poorly, but I have no basis to judge that; Beltra offers standard private legal cover.",
		candidates: [GOLDEN_BELTRA],
		expected: { "c-beltra": { category: "neutral", scoreRange: [50, 50] } },
		reference: { entities: [e("c-beltra", 50, "neutral", ["Beltra offers standard private legal cover"])] },
	},
	{
		id: "g11-adopted-opinion-en",
		lang: "en",
		answer:
			"Independent tests praise Corvex for its excellent claims handling, and in my view that praise is deserved.",
		candidates: [GOLDEN_CORVEX],
		expected: {
			"c-corvex": { category: "positive", scoreRange: [65, 95], aspects: { service: { category: "positive" } } },
		},
		reference: {
			entities: [
				e(
					"c-corvex",
					80,
					"positive",
					["that praise is deserved"],
					[a("service", 82, "positive", ["excellent claims handling"])],
				),
			],
		},
	},
	{
		id: "g12-pronoun-de",
		lang: "de",
		answer:
			"Ein Blick auf Arvo lohnt sich. Sie bieten eine kostenlose Erstberatung, und ihre App gilt als sehr benutzerfreundlich.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [60, 95], aspects: { service: { category: "positive" } } } },
		reference: {
			entities: [
				e(
					"brand",
					75,
					"positive",
					["Ein Blick auf Arvo lohnt sich"],
					[a("service", 78, "positive", ["ihre App gilt als sehr benutzerfreundlich"])],
				),
			],
		},
	},
	{
		id: "g13-multi-entity-de",
		lang: "de",
		critical: true,
		answer:
			"Arvo überzeugt mit schneller Regulierung. Beltra ist dagegen teuer. Corvex wird häufig genannt, ohne dass Details bekannt sind.",
		candidates: [GOLDEN_BRAND, GOLDEN_BELTRA, GOLDEN_CORVEX],
		expected: {
			brand: { category: "positive", scoreRange: [60, 95], aspects: { service: { category: "positive" } } },
			"c-beltra": { category: "negative", scoreRange: [10, 45], aspects: { price: { category: "negative" } } },
			"c-corvex": { category: "neutral", scoreRange: [50, 50] },
		},
		reference: {
			entities: [
				e(
					"brand",
					78,
					"positive",
					["Arvo überzeugt mit schneller Regulierung"],
					[a("service", 80, "positive", ["schneller Regulierung"])],
				),
				e(
					"c-beltra",
					30,
					"negative",
					["Beltra ist dagegen teuer"],
					[a("price", 28, "negative", ["Beltra ist dagegen teuer"])],
				),
				e("c-corvex", 50, "neutral", ["Corvex wird häufig genannt, ohne dass Details bekannt sind"]),
			],
		},
	},
	{
		id: "g14-mixed-with-aspects-en",
		lang: "en",
		answer:
			"Arvo has the most complete coverage on the market, yet its premiums are the highest and customer support is only reachable by phone.",
		candidates: [GOLDEN_BRAND],
		expected: {
			brand: {
				category: "mixed",
				scoreRange: [50, 50],
				aspects: {
					coverage: { category: "positive" },
					price: { category: "negative" },
					service: { category: "negative" },
				},
			},
		},
		reference: {
			entities: [
				e(
					"brand",
					50,
					"mixed",
					["the most complete coverage on the market", "its premiums are the highest"],
					[
						a("coverage", 85, "positive", ["the most complete coverage on the market"]),
						a("price", 25, "negative", ["its premiums are the highest"]),
						a("service", 40, "negative", ["customer support is only reachable by phone"]),
					],
				),
			],
		},
	},
	{
		id: "g15-list-de",
		lang: "de",
		answer: "Bekannte Anbieter:\n- Arvo\n- Beltra\n- Corvex\n- Dunhill Schutz",
		candidates: [GOLDEN_BRAND, GOLDEN_BELTRA, GOLDEN_CORVEX, GOLDEN_DUNHILL],
		expected: {
			brand: { category: "neutral", scoreRange: [50, 50] },
			"c-beltra": { category: "neutral", scoreRange: [50, 50] },
			"c-corvex": { category: "neutral", scoreRange: [50, 50] },
			"c-dunhill": { category: "neutral", scoreRange: [50, 50] },
		},
		reference: {
			entities: [
				e("brand", 50, "neutral", ["- Arvo"]),
				e("c-beltra", 50, "neutral", ["- Beltra"]),
				e("c-corvex", 50, "neutral", ["- Corvex"]),
				e("c-dunhill", 50, "neutral", ["- Dunhill Schutz"]),
			],
		},
	},
	{
		id: "g16-conditional-en",
		lang: "en",
		answer:
			"If you mainly need traffic legal protection, Dunhill is a strong choice; for landlords it is less suitable because rental disputes are excluded.",
		candidates: [GOLDEN_DUNHILL],
		expected: {
			"c-dunhill": { category: "mixed", scoreRange: [50, 50], aspects: { coverage: { category: "mixed" } } },
		},
		reference: {
			entities: [
				e(
					"c-dunhill",
					50,
					"mixed",
					["Dunhill is a strong choice", "rental disputes are excluded"],
					[a("coverage", 50, "mixed", ["Dunhill is a strong choice", "rental disputes are excluded"])],
				),
			],
		},
	},
	{
		id: "g17-price-increase-de",
		lang: "de",
		answer: "Arvo hat die Beiträge 2026 um zwölf Prozent erhöht, was viele Kunden verärgert hat.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "negative", scoreRange: [15, 45], aspects: { price: { category: "negative" } } } },
		reference: {
			entities: [
				e(
					"brand",
					32,
					"negative",
					["Beiträge 2026 um zwölf Prozent erhöht"],
					[a("price", 30, "negative", ["Beiträge 2026 um zwölf Prozent erhöht"])],
				),
			],
		},
	},
	{
		id: "g18-endorsement-en",
		lang: "en",
		answer: "Corvex is the best legal insurer I know of — fast, fair and affordable.",
		candidates: [GOLDEN_CORVEX],
		expected: {
			"c-corvex": {
				category: "positive",
				scoreRange: [85, 100],
				aspects: { price: { category: "positive" }, service: { category: "positive" } },
			},
		},
		reference: {
			entities: [
				e(
					"c-corvex",
					95,
					"positive",
					["Corvex is the best legal insurer I know of"],
					[a("service", 88, "positive", ["fast, fair"]), a("price", 85, "positive", ["affordable"])],
				),
			],
		},
	},
	{
		id: "g19-exclusion-de",
		lang: "de",
		critical: true,
		answer: "Für Selbstständige kommt Beltra nicht in Frage, weil kein Firmenrechtsschutz angeboten wird.",
		candidates: [GOLDEN_BELTRA],
		expected: {
			"c-beltra": { category: "negative", scoreRange: [10, 45], aspects: { coverage: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"c-beltra",
					30,
					"negative",
					["kommt Beltra nicht in Frage"],
					[a("coverage", 25, "negative", ["kein Firmenrechtsschutz angeboten wird"])],
				),
			],
		},
	},
	{
		id: "g20-negation-positive-de",
		lang: "de",
		critical: true,
		answer: "Es gibt bei Arvo keine versteckten Kosten und keine langen Wartezeiten.",
		candidates: [GOLDEN_BRAND],
		expected: {
			brand: {
				category: "positive",
				scoreRange: [60, 90],
				aspects: { price: { category: "positive" }, coverage: { category: "positive" } },
			},
		},
		reference: {
			entities: [
				e(
					"brand",
					74,
					"positive",
					["keine versteckten Kosten und keine langen Wartezeiten"],
					[
						a("price", 72, "positive", ["keine versteckten Kosten"]),
						a("coverage", 70, "positive", ["keine langen Wartezeiten"]),
					],
				),
			],
		},
	},
	{
		id: "g21-en-factual",
		lang: "en",
		answer: "Beltra was founded in 1998 and is headquartered in Munich.",
		candidates: [GOLDEN_BELTRA],
		expected: { "c-beltra": { category: "neutral", scoreRange: [50, 50] } },
		reference: { entities: [e("c-beltra", 50, "neutral", ["Beltra was founded in 1998"])] },
	},
	{
		id: "g22-service-negative-en",
		lang: "en",
		answer: "Customers report that Arvo takes weeks to answer emails and that the hotline is constantly busy.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "negative", scoreRange: [10, 45], aspects: { service: { category: "negative" } } } },
		reference: {
			entities: [
				e(
					"brand",
					28,
					"negative",
					["Arvo takes weeks to answer emails"],
					[a("service", 25, "negative", ["the hotline is constantly busy"])],
				),
			],
		},
	},
	{
		id: "g23-alias-de",
		lang: "de",
		answer: "Arvo Rechtsschutz punktet mit einer kostenlosen telefonischen Erstberatung.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [60, 90], aspects: { service: { category: "positive" } } } },
		reference: {
			entities: [
				e(
					"brand",
					72,
					"positive",
					["punktet mit einer kostenlosen telefonischen Erstberatung"],
					[a("service", 75, "positive", ["kostenlosen telefonischen Erstberatung"])],
				),
			],
		},
	},
	{
		id: "g24-two-negatives-en",
		lang: "en",
		answer: "Both Beltra and Corvex have been criticised for raising premiums twice within a year.",
		candidates: [GOLDEN_BELTRA, GOLDEN_CORVEX],
		expected: {
			"c-beltra": { category: "negative", scoreRange: [15, 45], aspects: { price: { category: "negative" } } },
			"c-corvex": { category: "negative", scoreRange: [15, 45], aspects: { price: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"c-beltra",
					32,
					"negative",
					["Both Beltra and Corvex have been criticised for raising premiums twice"],
					[a("price", 30, "negative", ["raising premiums twice within a year"])],
				),
				e(
					"c-corvex",
					32,
					"negative",
					["Both Beltra and Corvex have been criticised for raising premiums twice"],
					[a("price", 30, "negative", ["raising premiums twice within a year"])],
				),
			],
		},
	},
	{
		id: "g25-brand-positive-competitor-neutral-de",
		lang: "de",
		critical: true,
		answer:
			"Im Vergleich zu Dunhill Schutz bietet Arvo deutlich mehr Leistungen zum gleichen Beitrag. Dunhill Schutz ist seit 2010 am Markt.",
		candidates: [GOLDEN_BRAND, GOLDEN_DUNHILL],
		expected: {
			brand: { category: "positive", scoreRange: [60, 95], aspects: { coverage: { category: "positive" } } },
			"c-dunhill": { category: "negative", scoreRange: [25, 49], aspects: { coverage: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"brand",
					76,
					"positive",
					["bietet Arvo deutlich mehr Leistungen zum gleichen Beitrag"],
					[a("coverage", 78, "positive", ["deutlich mehr Leistungen zum gleichen Beitrag"])],
				),
				e(
					"c-dunhill",
					40,
					"negative",
					["Im Vergleich zu Dunhill Schutz bietet Arvo deutlich mehr Leistungen"],
					[a("coverage", 40, "negative", ["Im Vergleich zu Dunhill Schutz bietet Arvo deutlich mehr Leistungen"])],
				),
			],
		},
	},
	{
		id: "g26-repetition-en",
		lang: "en",
		answer: "Arvo, Arvo and once more Arvo — every comparison portal lists it among the top three for value for money.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [60, 95], aspects: { price: { category: "positive" } } } },
		reference: {
			entities: [
				e(
					"brand",
					78,
					"positive",
					["among the top three for value for money"],
					[a("price", 78, "positive", ["top three for value for money"])],
				),
			],
		},
	},
	{
		id: "g27-caveat-de",
		lang: "de",
		answer:
			"Corvex ist grundsätzlich solide, wobei die Wartezeit von sechs Monaten im Arbeitsrecht beachtet werden sollte.",
		candidates: [GOLDEN_CORVEX],
		expected: {
			"c-corvex": { category: "mixed", scoreRange: [50, 50], aspects: { coverage: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"c-corvex",
					50,
					"mixed",
					["Corvex ist grundsätzlich solide", "die Wartezeit von sechs Monaten"],
					[a("coverage", 40, "negative", ["die Wartezeit von sechs Monaten im Arbeitsrecht"])],
				),
			],
		},
	},
	{
		id: "g28-strong-negative-en",
		lang: "en",
		answer:
			"Avoid Dunhill Schutz at all costs: they denied every claim I have heard of and cancelled policies without notice.",
		candidates: [GOLDEN_DUNHILL],
		expected: {
			"c-dunhill": { category: "negative", scoreRange: [0, 20], aspects: { service: { category: "negative" } } },
		},
		reference: {
			entities: [
				e(
					"c-dunhill",
					8,
					"negative",
					["Avoid Dunhill Schutz at all costs"],
					[a("service", 10, "negative", ["they denied every claim I have heard of"])],
				),
			],
		},
	},
	{
		id: "g29-other-aspect-de",
		lang: "de",
		answer: "Arvo gilt als finanzstark und traditionsreich; die Beiträge liegen im Mittelfeld.",
		candidates: [GOLDEN_BRAND],
		expected: {
			brand: {
				category: "positive",
				scoreRange: [55, 85],
				aspects: { other: { category: "positive" }, price: { category: "neutral" } },
			},
		},
		reference: {
			entities: [
				e(
					"brand",
					68,
					"positive",
					["Arvo gilt als finanzstark und traditionsreich"],
					[
						a("other", 75, "positive", ["finanzstark und traditionsreich"]),
						a("price", 50, "neutral", ["die Beiträge liegen im Mittelfeld"]),
					],
				),
			],
		},
	},
	{
		id: "g30-en-neutral-description",
		lang: "en",
		answer: "Corvex offers private, traffic and landlord legal protection with an optional family add-on.",
		candidates: [GOLDEN_CORVEX],
		expected: { "c-corvex": { category: "neutral", scoreRange: [50, 50] } },
		reference: {
			entities: [e("c-corvex", 50, "neutral", ["Corvex offers private, traffic and landlord legal protection"])],
		},
	},
	{
		id: "g31-brand-negative-competitor-positive-de",
		lang: "de",
		critical: true,
		answer: "Während Beltra Schäden meist innerhalb einer Woche reguliert, dauert es bei Arvo oft Monate.",
		candidates: [GOLDEN_BRAND, GOLDEN_BELTRA],
		expected: {
			brand: { category: "negative", scoreRange: [10, 45], aspects: { service: { category: "negative" } } },
			"c-beltra": { category: "positive", scoreRange: [60, 95], aspects: { service: { category: "positive" } } },
		},
		reference: {
			entities: [
				e(
					"brand",
					28,
					"negative",
					["dauert es bei Arvo oft Monate"],
					[a("service", 25, "negative", ["dauert es bei Arvo oft Monate"])],
				),
				e(
					"c-beltra",
					78,
					"positive",
					["Beltra Schäden meist innerhalb einer Woche reguliert"],
					[a("service", 80, "positive", ["innerhalb einer Woche reguliert"])],
				),
			],
		},
	},
	{
		id: "g32-en-price-only",
		lang: "en",
		answer: "Beltra's basic tariff costs 14 euros per month, one of the cheapest on the market.",
		candidates: [GOLDEN_BELTRA],
		expected: {
			"c-beltra": { category: "positive", scoreRange: [55, 85], aspects: { price: { category: "positive" } } },
		},
		reference: {
			entities: [
				e(
					"c-beltra",
					70,
					"positive",
					["one of the cheapest on the market"],
					[a("price", 78, "positive", ["one of the cheapest on the market"])],
				),
			],
		},
	},
	{
		id: "g33-hedged-negative-de",
		lang: "de",
		answer: "Arvo ist nicht unbedingt die erste Wahl, wenn man Wert auf digitale Schadenmeldung legt.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "negative", scoreRange: [30, 49], aspects: { service: { category: "negative" } } } },
		reference: {
			entities: [
				e(
					"brand",
					42,
					"negative",
					["nicht unbedingt die erste Wahl"],
					[a("service", 40, "negative", ["Wert auf digitale Schadenmeldung legt"])],
				),
			],
		},
	},
	{
		id: "g34-en-mixed-two-competitors",
		lang: "en",
		answer: "Dunhill is cheap but slow; Corvex is pricey but excellent at claims.",
		candidates: [GOLDEN_DUNHILL, GOLDEN_CORVEX],
		expected: {
			"c-dunhill": {
				category: "mixed",
				scoreRange: [50, 50],
				aspects: { price: { category: "positive" }, service: { category: "negative" } },
			},
			"c-corvex": {
				category: "mixed",
				scoreRange: [50, 50],
				aspects: { price: { category: "negative" }, service: { category: "positive" } },
			},
		},
		reference: {
			entities: [
				e(
					"c-dunhill",
					50,
					"mixed",
					["Dunhill is cheap", "but slow"],
					[a("price", 75, "positive", ["Dunhill is cheap"]), a("service", 30, "negative", ["but slow"])],
				),
				e(
					"c-corvex",
					50,
					"mixed",
					["Corvex is pricey", "excellent at claims"],
					[a("price", 30, "negative", ["Corvex is pricey"]), a("service", 85, "positive", ["excellent at claims"])],
				),
			],
		},
	},
	{
		id: "g35-de-domain-mention",
		lang: "de",
		answer: "Details zu den Tarifen finden Sie auf arvo.example; dort ist auch der Tarifrechner verlinkt.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "neutral", scoreRange: [50, 50] } },
		reference: { entities: [e("brand", 50, "neutral", ["Details zu den Tarifen finden Sie auf arvo.example"])] },
	},
	{
		id: "g36-en-conditional-recommendation",
		lang: "en",
		answer: "Unless you need coverage abroad, Arvo is the sensible pick.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [55, 85] } },
		reference: { entities: [e("brand", 68, "positive", ["Arvo is the sensible pick"])] },
	},
	{
		id: "g37-de-question-list",
		lang: "de",
		answer:
			"Welche Anbieter gibt es? Arvo, Beltra und Corvex sind die bekanntesten; welcher passt, hängt vom Bedarf ab.",
		candidates: [GOLDEN_BRAND, GOLDEN_BELTRA, GOLDEN_CORVEX],
		expected: {
			brand: { category: "neutral", scoreRange: [50, 50] },
			"c-beltra": { category: "neutral", scoreRange: [50, 50] },
			"c-corvex": { category: "neutral", scoreRange: [50, 50] },
		},
		reference: {
			entities: [
				e("brand", 50, "neutral", ["Arvo, Beltra und Corvex sind die bekanntesten"]),
				e("c-beltra", 50, "neutral", ["Arvo, Beltra und Corvex sind die bekanntesten"]),
				e("c-corvex", 50, "neutral", ["Arvo, Beltra und Corvex sind die bekanntesten"]),
			],
		},
	},
	{
		id: "g38-en-service-positive-price-negative",
		lang: "en",
		answer: "Arvo's advisors are outstanding, though you pay a premium for that level of service.",
		candidates: [GOLDEN_BRAND],
		expected: {
			brand: {
				category: "mixed",
				scoreRange: [50, 50],
				aspects: { service: { category: "positive" }, price: { category: "negative" } },
			},
		},
		reference: {
			entities: [
				e(
					"brand",
					50,
					"mixed",
					["Arvo's advisors are outstanding", "you pay a premium for that level of service"],
					[
						a("service", 88, "positive", ["Arvo's advisors are outstanding"]),
						a("price", 35, "negative", ["you pay a premium"]),
					],
				),
			],
		},
	},
	{
		id: "g39-de-market-leader",
		lang: "de",
		answer: "Marktführer ist Dunhill Schutz mit rund 30 Prozent Marktanteil.",
		candidates: [GOLDEN_DUNHILL],
		expected: { "c-dunhill": { category: "neutral", scoreRange: [50, 50] } },
		reference: {
			entities: [e("c-dunhill", 50, "neutral", ["Marktführer ist Dunhill Schutz mit rund 30 Prozent Marktanteil"])],
		},
	},
	{
		id: "g40-en-warning-then-positive-other",
		lang: "en",
		critical: true,
		answer: "Be careful with Beltra's small print. Arvo, on the other hand, states its exclusions plainly.",
		candidates: [GOLDEN_BELTRA, GOLDEN_BRAND],
		expected: {
			"c-beltra": { category: "negative", scoreRange: [20, 49], aspects: { coverage: { category: "negative" } } },
			brand: { category: "positive", scoreRange: [55, 90], aspects: { coverage: { category: "positive" } } },
		},
		reference: {
			entities: [
				e(
					"c-beltra",
					38,
					"negative",
					["Be careful with Beltra's small print"],
					[a("coverage", 38, "negative", ["Be careful with Beltra's small print"])],
				),
				e(
					"brand",
					70,
					"positive",
					["states its exclusions plainly"],
					[a("coverage", 70, "positive", ["states its exclusions plainly"])],
				),
			],
		},
	},
	{
		id: "g41-de-negative-industry-positive-brand",
		lang: "de",
		critical: true,
		answer:
			"Viele Rechtsschutzversicherer lehnen Anfragen schleppend ab. Arvo bildet hier die Ausnahme und meldet sich innerhalb von 48 Stunden.",
		candidates: [GOLDEN_BRAND],
		expected: { brand: { category: "positive", scoreRange: [60, 95], aspects: { service: { category: "positive" } } } },
		reference: {
			entities: [
				e(
					"brand",
					78,
					"positive",
					["Arvo bildet hier die Ausnahme"],
					[a("service", 80, "positive", ["meldet sich innerhalb von 48 Stunden"])],
				),
			],
		},
	},
	{
		id: "g42-en-mention-only-in-passing",
		lang: "en",
		answer: "Unlike car insurance, legal insurance such as the policies sold by Corvex covers lawyer and court fees.",
		candidates: [GOLDEN_CORVEX],
		expected: { "c-corvex": { category: "neutral", scoreRange: [50, 50] } },
		reference: {
			entities: [e("c-corvex", 50, "neutral", ["the policies sold by Corvex covers lawyer and court fees"])],
		},
	},
];
