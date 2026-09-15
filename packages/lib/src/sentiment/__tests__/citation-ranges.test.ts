/**
 * UT-SNT-CIT-001 / UT-SNT-CIT-002 — citation-only occurrences are not mentions
 * and citation fragments are never evidence anchors. Written RED against the
 * v1 detector and the v1 segmenter, which scanned URL tokens, Markdown link
 * destinations and source lines like prose.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { sentimentInputHash, validateSentimentResult } from "../classifier";
import { brandEntity, competitorEntity, detectEntityMentions } from "../detector";
import { buildSentimentPrompt } from "../prompt";
import type { SentimentCandidate } from "../types";

const brand = brandEntity({ name: "ARAG", aliases: [], website: "https://arag.de/", additionalDomains: ["arag.com"] });
const adac = competitorEntity({ id: "c-adac", name: "ADAC", aliases: [], domains: ["adac.de"] });
const huk = competitorEntity({ id: "c-huk", name: "HUK-COBURG", aliases: ["HUK"], domains: ["huk.de"] });
const roster = [brand, adac, huk];
const keys = (text: string, entities = roster) => detectEntityMentions(text, entities).map((m) => m.key);

const candidatesFor = (...entityKeys: string[]): SentimentCandidate[] =>
	roster
		.filter((e) => entityKeys.includes(e.key))
		.map((e) => ({ key: e.key, entityType: e.entityType, competitorId: e.competitorId, name: e.name, aliases: e.aliases }));

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("UT-SNT-CIT-001 citation-only occurrences are not mentions", () => {
	it("a bare domain or URL never creates a mention", () => {
		expect(keys("Mehr Informationen unter adac.de.")).toEqual([]);
		expect(keys("Siehe https://www.adac.de/rechtsschutz/ für Details.")).toEqual([]);
		expect(keys("Siehe www.huk.de und https://arag.de/tarife?utm_source=openai")).toEqual([]);
	});

	it("a Markdown source line and a standalone linked brand in a source list never create a mention", () => {
		expect(keys("- [ADAC](https://www.adac.de/produkte/versicherungen/)")).toEqual([]);
		expect(keys("Quellen:\n1. [HUK-COBURG](https://huk.de)\n2. [ARAG](https://arag.de)")).toEqual([]);
		expect(keys("[1]: https://www.adac.de/\n[2]: https://arag.de/")).toEqual([]);
	});

	it("a brand alias inside a URL path or query is not a mention", () => {
		expect(keys("Vergleich: https://vergleich.example/tarife?anbieter=huk&sort=preis")).toEqual([]);
		expect(keys("https://ratgeber.example/versicherer/arag/rechtsschutz")).toEqual([]);
	});

	it("a natural sentence creates the mention, also beside an inline citation, and the citation adds no second term", () => {
		expect(keys("Die ARAG bietet Rechtsschutz ohne Wartezeit an.")).toEqual(["brand"]);
		const inline = detectEntityMentions("Die ARAG bietet Rechtsschutz an ([Quelle](https://arag.de/produkte)).", roster);
		expect(inline.map((m) => m.key)).toEqual(["brand"]);
		expect(inline[0].matchedTerms).toEqual(["arag"]);
		const duplicate = detectEntityMentions("ADAC ist eine gute Wahl. ([adac.de](https://www.adac.de/))", roster);
		expect(duplicate.map((m) => m.key)).toEqual(["c-adac"]);
		expect(duplicate[0].matchedTerms).toEqual(["adac"]);
	});

	it("an entity present in prose and in citation metadata counts exactly once", () => {
		const text = "HUK-COBURG ist günstig. ([huk.de](https://huk.de/x)) Die HUK punktet beim Service. Quelle: https://huk.de";
		const found = detectEntityMentions(text, roster);
		expect(found.map((m) => m.key)).toEqual(["c-huk"]);
		expect(found[0].matchedTerms).toEqual(["huk-coburg", "huk"]);
	});

	it("is byte-deterministic under reversed or shuffled rosters and identical for CRLF and LF bodies", () => {
		const lf = "Die ARAG ist gut. ([arag.de](https://arag.de))\nHUK ist teuer.\n- [ADAC](https://adac.de)";
		const crlf = lf.replaceAll("\n", "\r\n");
		const expected = ["brand", "c-huk"];
		expect(keys(lf)).toEqual(expected);
		expect(keys(crlf)).toEqual(expected);
		expect(keys(lf, [...roster].reverse())).toEqual(expected);
		expect(keys(lf, [huk, brand, adac])).toEqual(expected);
		expect(JSON.stringify(detectEntityMentions(lf, roster))).toBe(JSON.stringify(detectEntityMentions(crlf, [adac, huk, brand])));
	});
});

describe("UT-SNT-CIT-002 citation fragments are never anchors, edges, evidence or prompt text", () => {
	const answer =
		"Satz eins über die ARAG. ([arag.de](https://arag.de/tarife?utm_source=openai))\nSatz zwei über die HUK-COBURG.\n\nQuellen:\n- https://www.adac.de/rechtsschutz/\n- [ADAC](https://www.adac.de/)";

	it("a trailing inline citation and a source list are not anchors; natural anchors stay exact raw slices", () => {
		const anchors = segmentAnswer(answer);
		expect(anchors.map((a) => a.text)).toEqual(["Satz eins über die ARAG.", "Satz zwei über die HUK-COBURG.", "Quellen:"]);
		for (const anchor of anchors) expect(answer.slice(anchor.start, anchor.end)).toBe(anchor.text);
		for (const anchor of anchors) expect(anchor.text).not.toMatch(/https?:|\]\(/u);
	});

	it("a citation inside a sentence stays inside the raw slice but never cuts or shifts the offsets", () => {
		const body = "Die ARAG ([arag.de](https://arag.de/x)) ist günstig, die HUK-COBURG nicht.";
		const anchors = segmentAnswer(body);
		expect(anchors).toHaveLength(1);
		expect(anchors[0]).toMatchObject({ start: 0, end: body.length, text: body });
		expect(body.slice(anchors[0].start, anchors[0].end)).toBe(anchors[0].text);
	});

	it("an excluded fragment cannot be returned as evidence: only natural anchors exist", () => {
		const body = "Satz eins über die ARAG. ([arag.de](https://arag.de/tarife))";
		const candidates = candidatesFor("brand");
		const result = {
			entities: [
				{
					key: "brand",
					score: 50,
					category: "neutral",
					confidence: 0.9,
					evidence: [{ anchorId: "s0002", polarity: "neutral" }],
					aspects: [],
				},
			],
		};
		expect(segmentAnswer(body).map((a) => a.id)).toEqual(["s0001"]);
		expect(() => validateSentimentResult(result, { answerBody: body, candidates })).toThrow(
			expect.objectContaining({ code: "evidence-unknown-anchor" }),
		);
	});

	it("changing only a citation URL leaves the classifier input hash and the prompt digest unchanged", () => {
		const a = "Die ARAG ist günstig. ([arag.de](https://arag.de/a?utm_source=openai))";
		const b = "Die ARAG ist günstig. ([arag.de](https://arag.de/b?utm_source=other))";
		const candidates = candidatesFor("brand");
		expect(sentimentInputHash(a, candidates)).toBe(sentimentInputHash(b, candidates));
		expect(sha(buildSentimentPrompt({ answerBody: a, candidates }))).toBe(sha(buildSentimentPrompt({ answerBody: b, candidates })));
		// A change in the natural text still changes both.
		const c = "Die ARAG ist teuer. ([arag.de](https://arag.de/a?utm_source=openai))";
		expect(sentimentInputHash(a, candidates)).not.toBe(sentimentInputHash(c, candidates));
	});

	it("the provider never reads a URL, a link destination or a source line", () => {
		const prompt = buildSentimentPrompt({ answerBody: answer, candidates: candidatesFor("brand", "c-huk") });
		const rendered = prompt.slice(prompt.indexOf('"""'));
		expect(rendered).not.toMatch(/https?:\/\//u);
		expect(rendered).not.toContain("adac.de");
		expect(rendered).toContain("[s0001] Satz eins über die ARAG.");
		expect(rendered).toContain("[s0002] Satz zwei über die HUK-COBURG.");
	});

	it("keeps Unicode, CRLF, punctuation and Markdown emphasis from breaking raw offsets around citations", () => {
		const body = "**Kurz gesagt:** Die ARAG ist gut 👍. ([arag.de](https://arag.de))\r\n- Die HUK-COBURG „punktet“ beim Service. ([huk.de](https://huk.de/))\r\n";
		const anchors = segmentAnswer(body);
		expect(anchors.map((a) => a.text)).toEqual([
			"**Kurz gesagt:** Die ARAG ist gut 👍.",
			"Die HUK-COBURG „punktet“ beim Service.",
		]);
		for (const anchor of anchors) expect(body.slice(anchor.start, anchor.end)).toBe(anchor.text);
		expect(keys(body)).toEqual(["brand", "c-huk"]);
	});
});
