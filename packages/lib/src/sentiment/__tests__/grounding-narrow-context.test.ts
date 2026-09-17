/**
 * V4-RED-010 (G1) / V4-RED-011 (G2) — the two narrow context rules the shadow
 * adjudication found missing, on sanitised structural stand-ins of the five
 * production targets they concern:
 *
 * - G1 product/list-heading inheritance: bullets directly under a bold
 *   product-title line naming exactly one candidate (`051ab35e` WGV coverage
 *   and service — two targets).
 * - G2 clarifying-question inheritance: the pronoun-led paragraph directly
 *   after a one-line clarifying question naming exactly one candidate
 *   (`1c152244` brand overall, coverage and service — three targets).
 *
 * Both rules are one hop, stop at every structural boundary and never attribute
 * an anchor that names another candidate. The generic single-candidate family
 * (`29848bef`, `54227043`, `b621fdf7`, `9c472bf5`) stays rejected by design.
 */
import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { SentimentValidationError, validateSentimentResult } from "../classifier";
import { groundAnchors, isAttributable } from "../grounding";
import type { SentimentCandidate } from "../types";

const ARVO: SentimentCandidate = { key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] };
const BELTRA: SentimentCandidate = {
	key: "c-beltra",
	entityType: "competitor",
	competitorId: "c-beltra",
	name: "Beltra",
	aliases: [],
};
const CALDO: SentimentCandidate = {
	key: "c-caldo",
	entityType: "competitor",
	competitorId: "c-caldo",
	name: "Caldo",
	aliases: [],
};

const ground = (answer: string, candidates = [ARVO, BELTRA]) => {
	const anchors = segmentAnswer(answer);
	return { anchors, map: groundAnchors(answer, anchors, candidates) };
};
const attributable = (answer: string, id: string, key: string, candidates = [ARVO, BELTRA]) => {
	const { map } = ground(answer, candidates);
	const g = map.get(id);
	if (!g) throw new Error(`no anchor ${id}`);
	return isAttributable(g, key);
};

/** Stand-in for 051ab35e: a bold product-title line, then the tariff's bullets, then another product block. */
const PRODUCT_BLOCKS =
	"Zwei günstige Tarife im Überblick.\n\n**Beltra SmartStart Starter-Rechtsschutz**\n- ab 4,99 € monatlich\n- keine Wartezeit und keine Selbstbeteiligung\n- telefonische Erstberatung und Vertragsprüfung\n- aber: kein vollständiger Rechtsschutz für alle Verfahren\n\n**Arvo Aktiv Komfort**\n- umfangreicher, meist etwas teurer";

/** Stand-in for 1c152244: a one-line clarifying question, then a pronoun-led paragraph, then generic advice. */
const CLARIFYING_QUESTION =
	"Meinst du **Arvo, die Versicherung**?\n\nKurz gesagt: **Sie kann gut sein, aber es hängt stark vom Tarif ab.** Die Leistungen werden teils positiv bewertet, gleichzeitig berichten Kunden von unterschiedlichen Erfahrungen bei der Schadenregulierung.\n\nWichtig ist deshalb:\n- Welcher Tarif und Preis?\n- Gibt es Wartezeiten und Ausschlüsse?";

describe("G1 — product-title list inheritance", () => {
	it("bullets directly under a bold product-title line naming one candidate are attributable to it and to nobody else", () => {
		const { anchors, map } = ground(PRODUCT_BLOCKS);
		// s0001 intro · s0002 Beltra title · s0003–s0006 Beltra bullets · s0007 Arvo title · s0008 Arvo bullet
		expect(anchors).toHaveLength(8);
		for (const id of ["s0003", "s0004", "s0005", "s0006"]) {
			expect(map.get(id), id).toMatchObject({ context: "list-intro" });
			expect(isAttributable(map.get(id)!, "c-beltra"), id).toBe(true);
			expect(isAttributable(map.get(id)!, "brand"), id).toBe(false);
		}
		expect(isAttributable(map.get("s0008")!, "brand")).toBe(true);
		expect(isAttributable(map.get("s0008")!, "c-beltra")).toBe(false);
	});

	it("a Beltra coverage aspect (Mixed) and service aspect cited on those bullets validate under the wire contract", () => {
		const result = {
			entities: [
				{
					key: "c-beltra",
					category: "mixed",
					score: 50,
					confidence: 0.9,
					positiveEvidence: [{ anchorId: "s0002", polarity: "positive" }],
					negativeEvidence: [{ anchorId: "s0006", polarity: "negative" }],
					aspects: [
						{
							key: "coverage",
							category: "mixed",
							score: 50,
							confidence: 0.9,
							positiveEvidence: [{ anchorId: "s0004", polarity: "positive" }],
							negativeEvidence: [{ anchorId: "s0006", polarity: "negative" }],
						},
						{
							key: "service",
							category: "positive",
							score: 80,
							confidence: 0.9,
							evidence: [{ anchorId: "s0005", polarity: "positive" }],
						},
					],
				},
				{
					key: "brand",
					category: "mixed",
					score: 50,
					confidence: 0.9,
					positiveEvidence: [{ anchorId: "s0008", polarity: "positive" }],
					negativeEvidence: [{ anchorId: "s0008", polarity: "negative" }],
					aspects: [],
				},
			],
		};
		const entities = validateSentimentResult(result, { answerBody: PRODUCT_BLOCKS, candidates: [ARVO, BELTRA] });
		expect(entities.find((e) => e.key === "c-beltra")?.aspects.map((a) => a.key)).toEqual(["coverage", "service"]);
	});

	it("the title must name exactly one candidate; a title naming two, or none, introduces nothing", () => {
		const two = "**Arvo und Beltra im Vergleich**\n- günstig\n- schnell";
		expect(attributable(two, "s0002", "brand")).toBe(false);
		expect(attributable(two, "s0002", "c-beltra")).toBe(false);
		const none = "**Vorteile**\n- großer Anbieter\n- solide Bewertungen";
		expect(attributable(none, "s0002", "brand")).toBe(false);
	});

	it("intervening prose, a heading, a table or another candidate's mention breaks the inheritance", () => {
		const prose = "**Beltra Plus**\n\nDazu ein allgemeiner Hinweis zu Tarifen.\n\n- keine Wartezeit";
		expect(attributable(prose, "s0003", "c-beltra")).toBe(false);
		const heading = "**Beltra Plus**\n\n## Allgemeines\n- keine Wartezeit";
		expect(attributable(heading, "s0003", "c-beltra")).toBe(false);
		const other = "**Beltra Plus**\n- Arvo ist teurer\n- keine Wartezeit";
		expect(attributable(other, "s0003", "c-beltra")).toBe(false);
		expect(attributable(other, "s0002", "brand")).toBe(true);
	});

	it("is one hop: the bullets do not pass the entity on to the paragraph after the list", () => {
		const after = "**Beltra Plus**\n- keine Wartezeit\n\nDer Service ist gut.";
		expect(attributable(after, "s0002", "c-beltra")).toBe(true);
		expect(attributable(after, "s0003", "c-beltra")).toBe(false);
	});

	it("a plain (non-emphasised) sentence naming a candidate without a colon is not a product title", () => {
		const plain = "Beltra Plus ist ein Tarif.\n- keine Wartezeit";
		expect(attributable(plain, "s0002", "c-beltra")).toBe(false);
	});

	it("CRLF line endings and Unicode bullets behave the same", () => {
		const crlf = "**Beltra Plus**\r\n• keine Wartezeit\r\n• Erstberatung";
		expect(attributable(crlf, "s0002", "c-beltra")).toBe(true);
		expect(attributable(crlf, "s0003", "c-beltra")).toBe(true);
	});
});

describe("G2 — clarifying-question inheritance", () => {
	it("the pronoun-led paragraph directly after a one-line clarifying question naming one candidate inherits it", () => {
		const { anchors, map } = ground(CLARIFYING_QUESTION, [ARVO]);
		// s0001 question · s0002 pronoun-led paragraph · s0003 generic intro · s0004/s0005 generic bullets
		expect(anchors).toHaveLength(5);
		expect(map.get("s0002")).toMatchObject({ context: "paragraph" });
		expect(isAttributable(map.get("s0002")!, "brand")).toBe(true);
		// The generic checklist after the next blank line inherits nothing (one hop, boundary).
		expect(isAttributable(map.get("s0003")!, "brand")).toBe(false);
		expect(isAttributable(map.get("s0004")!, "brand")).toBe(false);
		expect(isAttributable(map.get("s0005")!, "brand")).toBe(false);
	});

	it("a Mixed overall with coverage and service aspects cited on that paragraph validates", () => {
		const result = {
			entities: [
				{
					key: "brand",
					category: "mixed",
					score: 50,
					confidence: 0.9,
					positiveEvidence: [{ anchorId: "s0002", polarity: "positive" }],
					negativeEvidence: [{ anchorId: "s0002", polarity: "negative" }],
					aspects: [
						{
							key: "coverage",
							category: "positive",
							score: 75,
							confidence: 0.9,
							evidence: [{ anchorId: "s0002", polarity: "positive" }],
						},
						{
							key: "service",
							category: "negative",
							score: 25,
							confidence: 0.9,
							evidence: [{ anchorId: "s0002", polarity: "negative" }],
						},
					],
				},
			],
		};
		const entities = validateSentimentResult(result, { answerBody: CLARIFYING_QUESTION, candidates: [ARVO] });
		expect(entities[0].aspects.map((a) => a.key)).toEqual(["coverage", "service"]);
	});

	it("the paragraph must open with a bounded continuation form (DE/EN)", () => {
		for (const opener of [
			"Sie ist solide.",
			"Es kommt auf den Tarif an.",
			"Kurz gesagt: gut.",
			"In short, it is solid.",
			"Yes, it can be good.",
			"Ja, sie kann gut sein.",
		]) {
			const answer = `Meinst du **Arvo**?\n\n${opener}`;
			expect(attributable(answer, "s0002", "brand", [ARVO]), opener).toBe(true);
		}
		for (const opener of ["Rechtsschutz ist wichtig.", "Viele Anbieter sind teuer.", "Legal insurance varies a lot."]) {
			const answer = `Meinst du **Arvo**?\n\n${opener}`;
			expect(attributable(answer, "s0002", "brand", [ARVO]), opener).toBe(false);
		}
	});

	it("the question must be a single one-line block naming exactly one candidate", () => {
		expect(attributable("Meinst du Arvo oder Beltra?\n\nSie sind beide solide.", "s0002", "brand")).toBe(false);
		expect(attributable("Meinst du Arvo oder Beltra?\n\nSie sind beide solide.", "s0002", "c-beltra")).toBe(false);
		expect(attributable("Meinst du Arvo? Ich vermute es.\n\nSie ist solide.", "s0003", "brand")).toBe(false);
		expect(attributable("Meinst du Arvo?\nDas Angebot gilt seit 2025.\n\nSie ist solide.", "s0003", "brand")).toBe(
			false,
		);
		expect(attributable("Welche Versicherung meinst du?\n\nSie ist solide.", "s0002", "brand")).toBe(false);
	});

	it("a following paragraph that names another candidate inherits nothing, and inheritance never chains", () => {
		const other = "Meinst du Arvo?\n\nSie ist teurer als Beltra. Der Service ist gut.";
		expect(attributable(other, "s0002", "brand")).toBe(false);
		expect(attributable(other, "s0003", "brand")).toBe(false);
		const chain = "Meinst du Arvo?\n\nSie ist solide.\n\nEs gibt aber Kritik.";
		expect(attributable(chain, "s0002", "brand", [ARVO])).toBe(true);
		expect(attributable(chain, "s0003", "brand", [ARVO])).toBe(false);
	});

	it("a heading, list or table between the question and the paragraph breaks the rule", () => {
		expect(attributable("Meinst du Arvo?\n\n## Überblick\n\nSie ist solide.", "s0003", "brand", [ARVO])).toBe(false);
		expect(attributable("Meinst du Arvo?\n\n- Tarif A\n\nSie ist solide.", "s0003", "brand", [ARVO])).toBe(false);
	});

	it("is independent of candidate order and of CRLF line endings", () => {
		const answer = "Meinst du Arvo?\r\n\r\nSie ist solide.";
		expect(attributable(answer, "s0002", "brand", [BELTRA, CALDO, ARVO])).toBe(true);
		expect(attributable(answer, "s0002", "brand", [ARVO, CALDO, BELTRA])).toBe(true);
		expect(attributable(answer, "s0002", "c-caldo", [BELTRA, CALDO, ARVO])).toBe(false);
	});
});

describe("the generic single-candidate family stays rejected", () => {
	it("bullets under a generic bold label in a single-candidate answer carry no target (29848bef / 54227043 stand-in)", () => {
		const answer =
			"Wenn du die **Arvo-Versicherung** meinst: Ja, sie kann gut sein.\n\n**Vorteile:**\n- großer und etablierter Anbieter\n- solide Bewertungen\n\n**Nachteile:**\n- Beiträge können vergleichsweise hoch sein";
		const { map } = ground(answer, [ARVO]);
		for (const id of ["s0003", "s0004", "s0006"]) expect(isAttributable(map.get(id)!, "brand"), id).toBe(false);
		const result = {
			entities: [
				{
					key: "brand",
					category: "positive",
					score: 75,
					confidence: 0.9,
					evidence: [{ anchorId: "s0001", polarity: "positive" }],
					aspects: [
						{
							key: "price",
							category: "negative",
							score: 25,
							confidence: 0.9,
							evidence: [{ anchorId: "s0006", polarity: "negative" }],
						},
					],
				},
			],
		};
		let thrown: unknown;
		try {
			validateSentimentResult(result, { answerBody: answer, candidates: [ARVO] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SentimentValidationError);
		expect((thrown as SentimentValidationError).code).toBe("aspect-ungrounded");
	});

	it("a sibling bullet does not continue the previous bullet's entity (b621fdf7 stand-in)", () => {
		const answer =
			"- **Rechtsschutz:** Arvo gehört zu den großen Anbietern.\n- **Kundenservice:** Die Erfahrungen sind gemischt.";
		expect(attributable(answer, "s0002", "brand", [ARVO])).toBe(false);
	});

	it("the checklist stand-in of 9c472bf5 stays rejected even though the question rule now scopes the first paragraph", () => {
		const answer =
			"Meinst du: **„Ist Arvo gut?“**\n\n**Kurz gesagt: Es kommt stark auf den Tarif an.** Arvo ist ein großer Versicherer.\n\nAchte vor Abschluss besonders auf:\n- Wartezeiten und Ausschlüsse\n- Selbstbeteiligung\n- Beitragserhöhungen";
		const { map } = ground(answer, [ARVO]);
		expect(isAttributable(map.get("s0002")!, "brand")).toBe(true);
		for (const id of ["s0003", "s0004", "s0005", "s0006"])
			expect(isAttributable(map.get(id)!, "brand"), id).toBe(false);
	});
});
