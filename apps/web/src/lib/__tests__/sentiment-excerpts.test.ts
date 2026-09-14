/**
 * The excerpt planner decides what part of a stored answer the evidence card
 * shows. Its contract: every span is fully inside exactly one group, groups
 * are exact raw slices, windows merge only when they overlap or touch, the
 * result is independent of input order, and anything that is not an exact
 * slice of the answer is refused.
 */
import type { SentimentEvidence } from "@workspace/lib/sentiment";
import { describe, expect, it } from "vitest";
import {
	EXCERPT_BOUNDARY_REACH,
	EXCERPT_RADIUS,
	type ExcerptGroup,
	isExactEvidenceSpan,
	planExcerpts,
} from "@/lib/sentiment-excerpts";

const words = (n: number, seed = "wort") => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const span = (
	answer: string,
	quote: string,
	polarity: SentimentEvidence["polarity"] = "positive",
): SentimentEvidence => {
	const start = answer.indexOf(quote);
	if (start === -1) throw new Error(`fixture quote missing: ${quote}`);
	return { quote, start, end: start + quote.length, polarity };
};

/** The invariants every plan must satisfy. */
function assertPlan(answer: string, spans: SentimentEvidence[], groups: ExcerptGroup[]) {
	for (const group of groups) {
		expect(group.text).toBe(answer.slice(group.excerptStart, group.excerptEnd));
		expect(group.excerptStart).toBeLessThan(group.excerptEnd);
		expect(group.leadingEllipsis).toBe(group.excerptStart > 0);
		expect(group.trailingEllipsis).toBe(group.excerptEnd < answer.length);
		for (const h of group.highlights) {
			expect(h.start).toBeGreaterThanOrEqual(group.excerptStart);
			expect(h.end).toBeLessThanOrEqual(group.excerptEnd);
		}
	}
	// groups are ordered, disjoint and non-touching
	for (let i = 1; i < groups.length; i++) expect(groups[i].excerptStart).toBeGreaterThan(groups[i - 1].excerptEnd);
	// every span is covered by exactly one group's highlight in full
	for (const s of spans) {
		const owners = groups.filter((g) => g.highlights.some((h) => h.start <= s.start && h.end >= s.end));
		expect(owners, `span ${s.start}-${s.end}`).toHaveLength(1);
	}
}

describe("UT-SNT-EXC-002 excerpt planner", () => {
	it("one span gives one window around it, cut at word boundaries, with ellipses only where text is skipped", () => {
		const answer = `${words(60)} Alpha ist gut. ${words(60, "ende")}`;
		const spans = [span(answer, "Alpha ist gut.")];
		const groups = planExcerpts(answer, spans);
		assertPlan(answer, spans, groups);
		expect(groups).toHaveLength(1);
		const [g] = groups;
		expect(g.excerptStart).toBeGreaterThanOrEqual(spans[0].start - EXCERPT_RADIUS - EXCERPT_BOUNDARY_REACH);
		expect(g.excerptStart).toBeLessThanOrEqual(spans[0].start - EXCERPT_RADIUS);
		expect(g.excerptEnd).toBeGreaterThanOrEqual(spans[0].end + EXCERPT_RADIUS);
		expect(g.excerptEnd).toBeLessThanOrEqual(spans[0].end + EXCERPT_RADIUS + EXCERPT_BOUNDARY_REACH);
		// word boundaries, never mid-word
		expect(answer[g.excerptStart - 1]).toMatch(/\s/);
		expect(answer[g.excerptEnd]).toMatch(/\s/);
		expect(g.leadingEllipsis && g.trailingEllipsis).toBe(true);
		expect(g.highlights).toEqual([{ start: spans[0].start, end: spans[0].end, polarities: ["positive"] }]);
	});

	it("overlapping and touching windows merge into one group; distant spans stay separate", () => {
		const a = "Alpha ist gut.";
		const b = "Beta ist besser.";
		const c = "Gamma ist teuer.";
		const near = `${words(30)} ${a} ${words(10)} ${b} ${words(90)} ${c} ${words(30)}`;
		const spans = [span(near, a), span(near, b), span(near, c, "negative")];
		const groups = planExcerpts(near, spans);
		assertPlan(near, spans, groups);
		// a and b are ~70 chars apart (< 2 × radius) → shared window; c is far → own window
		expect(groups).toHaveLength(2);
		expect(groups[0].highlights).toHaveLength(2);
		expect(groups[1].highlights).toEqual([{ start: spans[2].start, end: spans[2].end, polarities: ["negative"] }]);
		// exactly touching windows also merge (end === next start)
		const touching = planExcerpts("x".repeat(400), [
			{ quote: "xxxx", start: 100, end: 104, polarity: "positive" },
			{ quote: "xxxx", start: 264, end: 268, polarity: "negative" },
		]);
		expect(touching).toHaveLength(1);
	});

	it("three distant spans give three groups whose total is far less than the whole answer", () => {
		const s1 = "Erstens ist Alpha stark.";
		const s2 = "Zweitens ist Alpha teuer.";
		const s3 = "Drittens bleibt Alpha solide.";
		const answer = `${s1} ${words(120)} ${s2} ${words(120, "mitte")} ${s3}`;
		const spans = [span(answer, s1), span(answer, s2, "negative"), span(answer, s3)];
		const groups = planExcerpts(answer, spans);
		assertPlan(answer, spans, groups);
		expect(groups).toHaveLength(3);
		expect(groups[0].leadingEllipsis).toBe(false);
		expect(groups[2].trailingEllipsis).toBe(false);
		expect(groups.reduce((n, g) => n + g.text.length, 0)).toBeLessThan(answer.length * 0.6);
	});

	it("is independent of input order and byte-identical across runs", () => {
		const s1 = "Erstens ist Alpha stark.";
		const s2 = "Zweitens ist Alpha teuer.";
		const s3 = "Drittens bleibt Alpha solide.";
		const answer = `${s1} ${words(120)} ${s2} ${words(120, "mitte")} ${s3}`;
		const spans = [span(answer, s1), span(answer, s2, "negative"), span(answer, s3)];
		const reference = JSON.stringify(planExcerpts(answer, spans));
		for (const order of [
			[spans[2], spans[0], spans[1]],
			[spans[1], spans[2], spans[0]],
			[spans[2], spans[1], spans[0]],
		]) {
			expect(JSON.stringify(planExcerpts(answer, order))).toBe(reference);
		}
		expect(JSON.stringify(planExcerpts(answer, spans))).toBe(reference);
	});

	it("spans at the very start and end of the answer are bounded by the answer with no ellipsis on that side", () => {
		const answer = `Anfang ist gut. ${words(200)} Ende ist schlecht.`;
		const spans = [span(answer, "Anfang ist gut."), span(answer, "Ende ist schlecht.", "negative")];
		const groups = planExcerpts(answer, spans);
		assertPlan(answer, spans, groups);
		expect(groups[0].excerptStart).toBe(0);
		expect(groups[0].leadingEllipsis).toBe(false);
		expect(groups[1].excerptEnd).toBe(answer.length);
		expect(groups[1].trailingEllipsis).toBe(false);
	});

	it("keeps raw code-unit offsets through Unicode, surrogate pairs and CRLF and never splits a pair", () => {
		const answer = `${"😀 ".repeat(90)}Alpha ist 👍 gut.\r\n${"ä".repeat(200)}\r\nSchluss 🎉 hier.`;
		const spans = [span(answer, "Alpha ist 👍 gut."), span(answer, "Schluss 🎉 hier.", "neutral")];
		const groups = planExcerpts(answer, spans);
		assertPlan(answer, spans, groups);
		for (const g of groups) {
			// no lone surrogate at either edge
			expect(g.text.charCodeAt(0)).not.toSatisfy((c: number) => c >= 0xdc00 && c <= 0xdfff);
			expect(g.text.charCodeAt(g.text.length - 1)).not.toSatisfy((c: number) => c >= 0xd800 && c <= 0xdbff);
		}
	});

	it("identical boundaries with two polarities become one highlight carrying both (Mixed on one anchor)", () => {
		const answer = `${words(20)} Alpha ist günstig, aber langsam. ${words(20)}`;
		const spans = [
			span(answer, "Alpha ist günstig, aber langsam."),
			span(answer, "Alpha ist günstig, aber langsam.", "negative"),
		];
		const groups = planExcerpts(answer, spans);
		assertPlan(answer, spans, groups);
		expect(groups).toHaveLength(1);
		expect(groups[0].highlights).toEqual([
			{ start: spans[0].start, end: spans[0].end, polarities: ["positive", "negative"] },
		]);
	});

	it("refuses malformed or out-of-range spans instead of approximating", () => {
		const answer = `${words(20)} Alpha ist gut. ${words(20)}`;
		const ok = span(answer, "Alpha ist gut.");
		const bad: SentimentEvidence[] = [
			{ ...ok, quote: "Alpha ist toll." },
			{ ...ok, end: answer.length + 5 },
			{ ...ok, start: -1 },
			{ ...ok, start: ok.end, end: ok.start },
			{ ...ok, start: ok.start + 0.5 },
			{ ...ok, start: ok.start, end: ok.start },
		];
		for (const b of bad) {
			expect(isExactEvidenceSpan(answer, b)).toBe(false);
			expect(() => planExcerpts(answer, [ok, b])).toThrow(RangeError);
		}
		expect(isExactEvidenceSpan(answer, ok)).toBe(true);
		expect(planExcerpts(answer, [])).toEqual([]);
	});
});
