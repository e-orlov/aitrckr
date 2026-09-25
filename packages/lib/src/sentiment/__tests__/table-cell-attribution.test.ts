import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type EvidenceAnchor, hasTableRows, segmentAnswer } from "../anchors";
import { sentimentInputHash, validateSentimentResult } from "../classifier";
import { belongsOnlyToOthers, groundAnchors, isAttributable } from "../grounding";
import { renderAnchoredAnswer } from "../prompt";
import { normalizeText } from "../text";
import type { SentimentCandidate } from "../types";

/**
 * SENT-ATTR-01 — an evaluative phrase is evidence for the entity it is about,
 * never for the entity next to it. The whole path is exercised on synthetic
 * text: phrase → its own anchor with exact offsets → attribution to one
 * entity → the stored evidence of a validated result, which is what the
 * Sentiment card highlights. Fictional tariffs of the two real candidate
 * names the production roster uses (ARAG is the brand, WGV a competitor).
 */
const ARAG: SentimentCandidate = { key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] };
const WGV: SentimentCandidate = {
	key: "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c",
	entityType: "competitor",
	competitorId: "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c",
	name: "WGV",
	aliases: ["Württembergische Gemeinde-Versicherung"],
};
const candidates = [ARAG, WGV];

/** The anchor whose raw text is exactly `text`, with its offsets checked against the answer. */
function anchorOf(answer: string, anchors: EvidenceAnchor[], text: string): EvidenceAnchor {
	const anchor = anchors.find((a) => a.text === text);
	expect(anchor, `anchor "${text}"`).toBeDefined();
	expect(answer.slice(anchor!.start, anchor!.end)).toBe(text);
	expect(answer.indexOf(text)).toBe(anchor!.start);
	return anchor!;
}

const cite = (polarity: "positive" | "negative", ...ids: string[]) => ids.map((anchorId) => ({ anchorId, polarity }));
const positive = (...ids: string[]) => ({ category: "positive", score: 80, confidence: 0.9, evidence: cite("positive", ...ids) });
const negative = (...ids: string[]) => ({ category: "negative", score: 25, confidence: 0.9, evidence: cite("negative", ...ids) });
const mixed = (positiveIds: string[], negativeIds: string[]) => ({
	category: "mixed",
	score: 50,
	confidence: 0.9,
	positiveEvidence: cite("positive", ...positiveIds),
	negativeEvidence: cite("negative", ...negativeIds),
});
const validate = (answer: string, entities: unknown[]) =>
	validateSentimentResult({ entities }, { answerBody: answer, candidates });
const quotesOf = (answer: string, entities: unknown[], key: string) =>
	validate(answer, entities)
		.find((e) => e.key === key)!
		.evidence.map((e) => e.quote);

describe("SENT-ATTR-01 evidence attribution per phrase", () => {
	describe("column-per-entity comparison table", () => {
		const answer =
			"| Kriterium | WGV PBV Optimal | ARAG Aktiv Komfort |\n|---|---|---|\n| Bewertung | Gutes Preis-Leistungs-Verhältnis | Im Vergleich zu teuer |";
		const anchors = segmentAnswer(answer);
		const grounding = groundAnchors(answer, anchors, candidates);
		const wgvCell = anchorOf(answer, anchors, "Gutes Preis-Leistungs-Verhältnis");
		const aragCell = anchorOf(answer, anchors, "Im Vergleich zu teuer");

		it("segments every cell on its own with exact offsets and no cell spans two columns", () => {
			expect(anchors.map((a) => a.text)).toEqual([
				"Kriterium",
				"WGV PBV Optimal",
				"ARAG Aktiv Komfort",
				"Bewertung",
				"Gutes Preis-Leistungs-Verhältnis",
				"Im Vergleich zu teuer",
			]);
			expect(wgvCell.table).toEqual({ row: 2, column: 1 });
			expect(aragCell.table).toEqual({ row: 2, column: 2 });
			for (const anchor of anchors) expect(anchor.text.includes("|")).toBe(false);
		});

		it("each evaluative cell belongs to the entity of its column header and to nobody else", () => {
			expect(isAttributable(grounding.get(wgvCell.id)!, WGV.key)).toBe(true);
			expect(isAttributable(grounding.get(wgvCell.id)!, ARAG.key)).toBe(false);
			expect(isAttributable(grounding.get(aragCell.id)!, ARAG.key)).toBe(true);
			expect(isAttributable(grounding.get(aragCell.id)!, WGV.key)).toBe(false);
			expect(belongsOnlyToOthers(grounding.get(aragCell.id)!, WGV.key)).toBe(true);
			expect(belongsOnlyToOthers(grounding.get(wgvCell.id)!, ARAG.key)).toBe(true);
			// The criterion label belongs to nobody: it can accompany a verdict but never carry one.
			expect(grounding.get(anchorOf(answer, anchors, "Bewertung").id)).toMatchObject({ context: "generic" });
		});

		it("stores exactly the entity's own phrase as evidence: WGV positive on its cell, ARAG negative on its cell", () => {
			const result = [
				{ key: ARAG.key, ...negative(aragCell.id), aspects: [] },
				{ key: WGV.key, ...positive(wgvCell.id), aspects: [] },
			];
			expect(quotesOf(answer, result, WGV.key)).toEqual(["Gutes Preis-Leistungs-Verhältnis"]);
			expect(quotesOf(answer, result, ARAG.key)).toEqual(["Im Vergleich zu teuer"]);
			const wgv = validate(answer, result).find((e) => e.key === WGV.key)!;
			expect(wgv.evidence[0]).toEqual({
				quote: "Gutes Preis-Leistungs-Verhältnis",
				start: wgvCell.start,
				end: wgvCell.end,
				polarity: "positive",
			});
		});

		it("refuses both cross attributions", () => {
			expect(() =>
				validate(answer, [
					{ key: ARAG.key, ...negative(aragCell.id), aspects: [] },
					{ key: WGV.key, ...negative(aragCell.id), aspects: [] },
				]),
			).toThrow(expect.objectContaining({ code: "evidence-entity-unbound", diagnostic: expect.objectContaining({ entityKey: WGV.key }) }));
			expect(() =>
				validate(answer, [
					{ key: ARAG.key, ...positive(wgvCell.id), aspects: [] },
					{ key: WGV.key, ...positive(wgvCell.id), aspects: [] },
				]),
			).toThrow(expect.objectContaining({ code: "evidence-entity-unbound", diagnostic: expect.objectContaining({ entityKey: ARAG.key }) }));
		});

		it("one correct citation never lets the neighbouring cell of the other entity into the stored evidence", () => {
			expect(() =>
				validate(answer, [
					{ key: ARAG.key, ...negative(aragCell.id), aspects: [] },
					{ key: WGV.key, ...mixed([wgvCell.id], [aragCell.id]), aspects: [] },
				]),
			).toThrow(
				expect.objectContaining({
					code: "evidence-entity-unbound",
					diagnostic: expect.objectContaining({ entityKey: WGV.key, anchorId: aragCell.id }),
				}),
			);
		});

		it("the model reads the table as a table: cells on one line, each with its own id", () => {
			expect(renderAnchoredAnswer(anchors)).toBe(
				[
					"| [s0001] Kriterium | [s0002] WGV PBV Optimal | [s0003] ARAG Aktiv Komfort |",
					"| [s0004] Bewertung | [s0005] Gutes Preis-Leistungs-Verhältnis | [s0006] Im Vergleich zu teuer |",
				].join("\n"),
			);
		});

		it("an answer with a table carries the evidence contract version in its input hash; one without keeps its hash", () => {
			expect(hasTableRows(answer)).toBe(true);
			const plain = "WGV ist günstig. ARAG ist teuer.";
			expect(hasTableRows(plain)).toBe(false);
			// The pre-v3 canonical form of a table-free answer is unchanged, so every stored result of such an answer stays current.
			const preV3 = createHash("sha256")
				.update(
					JSON.stringify({
						body: normalizeText(plain),
						candidates: [WGV, ARAG].map((c) => ({
							key: c.key,
							type: c.entityType,
							name: normalizeText(c.name),
							aliases: c.aliases.map(normalizeText).sort(),
						})),
					}),
				)
				.digest("hex");
			expect(sentimentInputHash(plain, candidates)).toBe(preV3);
			expect(sentimentInputHash(answer, candidates)).not.toBe(sentimentInputHash(plain, candidates));
		});
	});

	describe("sections and lists with their own headings", () => {
		const answer =
			"## WGV PBV Optimal\n- Gutes Preis-Leistungs-Verhältnis.\n## ARAG Aktiv Komfort\n- Im Vergleich zu teuer.";
		const anchors = segmentAnswer(answer);
		const grounding = groundAnchors(answer, anchors, candidates);
		const wgvItem = anchorOf(answer, anchors, "Gutes Preis-Leistungs-Verhältnis.");
		const aragItem = anchorOf(answer, anchors, "Im Vergleich zu teuer.");

		it("an item without a name belongs to its own section's entity only", () => {
			expect(grounding.get(wgvItem.id)).toMatchObject({ context: "heading" });
			expect(isAttributable(grounding.get(wgvItem.id)!, WGV.key)).toBe(true);
			expect(isAttributable(grounding.get(wgvItem.id)!, ARAG.key)).toBe(false);
			expect(isAttributable(grounding.get(aragItem.id)!, ARAG.key)).toBe(true);
			expect(isAttributable(grounding.get(aragItem.id)!, WGV.key)).toBe(false);
		});

		it("WGV keeps its own item and never stores the ARAG item, even next to a correct citation", () => {
			const own = [
				{ key: ARAG.key, ...negative(aragItem.id), aspects: [] },
				{ key: WGV.key, ...positive(wgvItem.id), aspects: [] },
			];
			expect(quotesOf(answer, own, WGV.key)).toEqual(["Gutes Preis-Leistungs-Verhältnis."]);
			expect(() =>
				validate(answer, [
					{ key: ARAG.key, ...negative(aragItem.id), aspects: [] },
					{ key: WGV.key, ...mixed([wgvItem.id], [aragItem.id]), aspects: [] },
				]),
			).toThrow(expect.objectContaining({ code: "evidence-entity-unbound", diagnostic: expect.objectContaining({ anchorId: aragItem.id }) }));
		});
	});

	describe("an explicit comparison of both entities inside one cell", () => {
		const answer =
			"| Kriterium | WGV | ARAG |\n|---|---|---|\n| Schutz | WGV bietet guten Schutz; ARAG hat ausdrücklich mangelhaften Schutz. | Keine weitere Bewertung. |";
		const anchors = segmentAnswer(answer);
		const grounding = groundAnchors(answer, anchors, candidates);
		const wgvClause = anchorOf(answer, anchors, "WGV bietet guten Schutz;");
		const aragClause = anchorOf(answer, anchors, "ARAG hat ausdrücklich mangelhaften Schutz.");

		it("splits the cell into the two statements, each about the entity it names — the column does not override the name", () => {
			expect(wgvClause.table).toEqual({ row: 2, column: 1 });
			expect(aragClause.table).toEqual({ row: 2, column: 1 });
			expect(grounding.get(wgvClause.id)).toMatchObject({ context: "explicit" });
			expect(isAttributable(grounding.get(wgvClause.id)!, WGV.key)).toBe(true);
			expect(isAttributable(grounding.get(wgvClause.id)!, ARAG.key)).toBe(false);
			expect(grounding.get(aragClause.id)).toMatchObject({ context: "explicit" });
			expect(isAttributable(grounding.get(aragClause.id)!, ARAG.key)).toBe(true);
			expect(isAttributable(grounding.get(aragClause.id)!, WGV.key)).toBe(false);
			// The plain cell of the ARAG column still belongs to ARAG.
			expect(isAttributable(grounding.get(anchorOf(answer, anchors, "Keine weitere Bewertung.").id)!, ARAG.key)).toBe(true);
		});

		it("keeps both independent attributions and their exact fragments", () => {
			const result = [
				{ key: ARAG.key, ...negative(aragClause.id), aspects: [] },
				{ key: WGV.key, ...positive(wgvClause.id), aspects: [] },
			];
			expect(quotesOf(answer, result, WGV.key)).toEqual(["WGV bietet guten Schutz;"]);
			expect(quotesOf(answer, result, ARAG.key)).toEqual(["ARAG hat ausdrücklich mangelhaften Schutz."]);
			expect(() =>
				validate(answer, [
					{ key: ARAG.key, ...negative(aragClause.id), aspects: [] },
					{ key: WGV.key, ...mixed([wgvClause.id], [aragClause.id]), aspects: [] },
				]),
			).toThrow(expect.objectContaining({ code: "evidence-entity-unbound" }));
		});
	});
});
