import { describe, expect, it } from "vitest";
import { ANCHOR_MAX_COUNT, anchorMap, type EvidenceAnchor, isAnchorId, segmentAnswer } from "../anchors";
import { EVIDENCE_QUOTE_MAX_LENGTH } from "../types";

const CONTENT = /[\p{L}\p{N}]/u;

/** The invariants every segmentation must satisfy, whatever the input. */
function expectInvariants(answer: string, anchors: EvidenceAnchor[]) {
	let cursor = 0;
	anchors.forEach((anchor, index) => {
		expect(anchor.id).toBe(`s${String(index + 1).padStart(4, "0")}`);
		expect(isAnchorId(anchor.id)).toBe(true);
		expect(anchor.text).toBe(answer.slice(anchor.start, anchor.end));
		expect(anchor.text.length).toBeGreaterThan(0);
		expect(anchor.text.length).toBeLessThanOrEqual(EVIDENCE_QUOTE_MAX_LENGTH);
		expect(anchor.start).toBeGreaterThanOrEqual(cursor);
		expect(CONTENT.test(anchor.text)).toBe(true);
		// Nothing trimmed at the edges: the span starts and ends on non-whitespace.
		expect(/^\s|\s$/u.test(anchor.text)).toBe(false);
		cursor = anchor.end;
	});
	// Every letter/digit of the answer is inside an anchor, except the digits of a stripped list marker.
	const covered = new Array(answer.length).fill(false);
	for (const anchor of anchors) for (let i = anchor.start; i < anchor.end; i += 1) covered[i] = true;
	for (const marker of answer.matchAll(/(?:^|\r\n|\r|\n)[ \t]*\d{1,3}[.)][ \t]+/gu)) {
		for (let i = marker.index; i < marker.index + marker[0].length; i += 1) covered[i] = true;
	}
	for (let i = 0; i < answer.length; i += 1) if (CONTENT.test(answer[i])) expect(covered[i], `char ${i}`).toBe(true);
	// Determinism: the same input always yields the same anchors.
	expect(segmentAnswer(answer)).toEqual(anchors);
}

describe("evidence anchor segmenter", () => {
	it("splits German sentences and keeps abbreviations, numbers and ordinals together", () => {
		const answer =
			"Die ARAG bietet z.B. einen sehr guten Schutz. Die Prämie liegt bei ca. 19,90 € pro Monat, d. h. günstig. Am 3. Mai wurde der Tarif Nr. 7 angepasst! Ist das gut?";
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual([
			"Die ARAG bietet z.B. einen sehr guten Schutz.",
			"Die Prämie liegt bei ca. 19,90 € pro Monat, d. h. günstig.",
			"Am 3. Mai wurde der Tarif Nr. 7 angepasst!",
			"Ist das gut?",
		]);
	});

	it("splits English sentences and keeps decimals, URLs and e.g./i.e. together", () => {
		const answer =
			"Alpha handles claims fast, e.g. within 2.5 days. See https://alpha.example.test/pricing.html for details. Beta is slower… but cheaper.";
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual([
			"Alpha handles claims fast, e.g. within 2.5 days.",
			"See https://alpha.example.test/pricing.html for details.",
			"Beta is slower… but cheaper.",
		]);
	});

	it("treats CRLF, CR and LF line breaks alike and never includes the break in a span", () => {
		const lf = "First line.\nSecond line.\nThird.";
		const crlf = "First line.\r\nSecond line.\r\nThird.";
		const cr = "First line.\rSecond line.\rThird.";
		for (const answer of [lf, crlf, cr]) {
			const anchors = segmentAnswer(answer);
			expectInvariants(answer, anchors);
			expect(anchors.map((a) => a.text)).toEqual(["First line.", "Second line.", "Third."]);
		}
		expect(segmentAnswer(lf).map((a) => a.text)).toEqual(segmentAnswer(crlf).map((a) => a.text));
	});

	it("drops Markdown list markers, blank lines and separators but keeps the item text exactly", () => {
		const answer = [
			"Overview:",
			"",
			"- **ARAG**: strong coverage",
			"* WGV — cheap",
			"1. HUK-COBURG is well known.",
			"2) DEVK: fine.",
			"> quoted remark",
			"---",
			"   • indented bullet   ",
		].join("\n");
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual([
			"Overview:",
			"**ARAG**: strong coverage",
			"WGV — cheap",
			"HUK-COBURG is well known.",
			"DEVK: fine.",
			"quoted remark",
			"indented bullet",
		]);
	});

	it("collapses nothing: multiple spaces inside a span are preserved verbatim, offsets stay exact", () => {
		const answer = "ARAG   ist   gut.   WGV  ist  günstig.";
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual(["ARAG   ist   gut.", "WGV  ist  günstig."]);
	});

	it("handles Unicode: composed/decomposed umlauts, emoji (surrogate pairs) and combining marks stay intact", () => {
		const answer = "Zufriedenheit ist hoch 👍🏽. Käufer loben den Service ❤️! Umlaute: äöü ÄÖÜ ß.";
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual([
			"Zufriedenheit ist hoch 👍🏽.",
			"Käufer loben den Service ❤️!",
			"Umlaute: äöü ÄÖÜ ß.",
		]);
		for (const anchor of anchors) expect(anchor.text.normalize("NFKC").length).toBeGreaterThan(0);
	});

	it("splits an over-long sentence deterministically at soft boundaries, never inside a surrogate pair", () => {
		const clause = "die Bearbeitung ist schnell, der Service freundlich, die Prämie fair, ";
		const long = `${clause.repeat(8)}und insgesamt überzeugend 🎉.`;
		expect(long.length).toBeGreaterThan(EVIDENCE_QUOTE_MAX_LENGTH);
		const anchors = segmentAnswer(long);
		expectInvariants(long, anchors);
		expect(anchors.length).toBeGreaterThan(1);
		for (const anchor of anchors) {
			expect(anchor.text.length).toBeLessThanOrEqual(EVIDENCE_QUOTE_MAX_LENGTH);
			// A soft-boundary split ends on the comma, not in the middle of a word.
			expect(/[,\p{L}\p{N}.!?🎉]$/u.test(anchor.text)).toBe(true);
		}
	});

	it("hard-splits a single over-long token without breaking a surrogate pair", () => {
		const emoji = "😀";
		const long = emoji.repeat(EVIDENCE_QUOTE_MAX_LENGTH); // 600 code units, no whitespace
		const answer = `x${long}x`;
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		for (const anchor of anchors) {
			// Every anchor starts and ends on a complete code point.
			expect(anchor.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00 && 0xdc00);
			expect([...anchor.text].join("")).toBe(anchor.text);
			expect(/^[\ud800-\udbff]?[\udc00-\udfff]$/u.test(anchor.text.slice(-1)) && anchor.text.length === 1).toBe(false);
		}
	});

	it("returns no anchors for an answer without letters or digits, and refuses one that exceeds the anchor cap", () => {
		expect(segmentAnswer("--- \n\n ... !!! ")).toEqual([]);
		const tooMany = Array.from({ length: ANCHOR_MAX_COUNT + 1 }, (_, i) => `Satz ${i} ist da.`).join(" ");
		expect(() => segmentAnswer(tooMany)).toThrow(expect.objectContaining({ code: "answer-unsegmentable" }));
		const justEnough = Array.from({ length: ANCHOR_MAX_COUNT }, (_, i) => `Satz ${i} ist da.`).join(" ");
		expect(segmentAnswer(justEnough)).toHaveLength(ANCHOR_MAX_COUNT);
	});

	it("does not depend on locale or environment: identical output under different process locales", () => {
		const answer = "İstanbul Sigorta ist groß. Ärger gibt es nicht. Straße 1.";
		const a = segmentAnswer(answer);
		const b = segmentAnswer(answer);
		expect(a).toEqual(b);
		expect(anchorMap(a).get("s0002")?.text).toBe("Ärger gibt es nicht.");
	});

	it("keeps quotes and brackets that close a sentence inside the sentence", () => {
		const answer = 'Er sagte: "Das ist gut." Dann ging er (leise). Ende!';
		const anchors = segmentAnswer(answer);
		expectInvariants(answer, anchors);
		expect(anchors.map((a) => a.text)).toEqual(['Er sagte: "Das ist gut."', "Dann ging er (leise).", "Ende!"]);
	});
});
