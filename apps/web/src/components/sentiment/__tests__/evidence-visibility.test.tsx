/**
 * Every stored evidence span must be fully visible in the expanded evidence
 * card: rendered highlighted text === answerBody.slice(start, end) for each
 * span, with no truncation, loss or merging. The anchored classifier cites
 * up to three sentences spread over the whole answer, so a single window
 * around the first span cannot satisfy this.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightExcerpt } from "@/components/sentiment/evidence-panels";
import { LONG_ANSWER, THREE_DISTANT_SPANS } from "./evidence-fixture";

/** The window the production loader builds today: ±160 raw characters around the first span only. */
function productionWindow(answer: string, spans: typeof THREE_DISTANT_SPANS) {
	const radius = 160;
	const first = spans[0];
	const start = Math.max(0, first.start - radius);
	const end = Math.min(answer.length, first.end + radius);
	return {
		excerpt: `${start > 0 ? "…" : ""}${answer.slice(start, end)}${end < answer.length ? "…" : ""}`,
		excerptStart: start > 0 ? start - 1 : 0,
	};
}

const marksOf = (html: string) =>
	[...html.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((m) =>
		m[1]
			.replace(/&quot;/g, '"')
			.replace(/&#x27;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">"),
	);

describe("UT-SNT-EXC-001 all evidence spans are rendered in full", () => {
	it("three distant anchors of one answer are each highlighted exactly once as the raw slice", () => {
		const { excerpt, excerptStart } = productionWindow(LONG_ANSWER, THREE_DISTANT_SPANS);
		const html = renderToStaticMarkup(<>{highlightExcerpt(excerpt, THREE_DISTANT_SPANS, excerptStart)}</>);
		const marks = marksOf(html);
		for (const span of THREE_DISTANT_SPANS) {
			const raw = LONG_ANSWER.slice(span.start, span.end);
			expect(marks, `span at ${span.start}-${span.end} must be highlighted in full`).toContain(raw);
		}
		expect(marks).toHaveLength(THREE_DISTANT_SPANS.length);
	});
});
