/**
 * Every stored evidence span must be fully visible in the expanded evidence
 * card: rendered highlighted text === answerBody.slice(start, end) for each
 * span, with no truncation, loss or merging. The anchored classifier cites
 * up to three sentences spread over the whole answer, so a single window
 * around the first span cannot satisfy this.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightExcerpt } from "@/components/sentiment/excerpt-highlight";
import { planExcerpts } from "@/lib/sentiment-excerpts";
import { LONG_ANSWER, THREE_DISTANT_SPANS } from "./evidence-fixture";

const marksOf = (html: string) =>
	[...html.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((m) =>
		m[1]
			.replace(/&quot;/g, '"')
			.replace(/&#x27;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">"),
	);

/** What the evidence card renders for one item: the marks of every excerpt group, in order. */
const renderedMarks = (answer: string, spans: typeof THREE_DISTANT_SPANS) =>
	planExcerpts(answer, spans).flatMap((group) => marksOf(renderToStaticMarkup(<>{highlightExcerpt(group)}</>)));

describe("UT-SNT-EXC-001 all evidence spans are rendered in full", () => {
	it("three distant anchors of one answer are each highlighted exactly once as the raw slice", () => {
		const marks = renderedMarks(LONG_ANSWER, THREE_DISTANT_SPANS);
		for (const span of THREE_DISTANT_SPANS) {
			const raw = LONG_ANSWER.slice(span.start, span.end);
			expect(marks, `span at ${span.start}-${span.end} must be highlighted in full`).toContain(raw);
		}
		expect(marks).toHaveLength(THREE_DISTANT_SPANS.length);
	});

	it("the rendered text of every group is the raw slice of the answer, so no highlight can differ from the stored span", () => {
		for (const group of planExcerpts(LONG_ANSWER, THREE_DISTANT_SPANS)) {
			expect(group.text).toBe(LONG_ANSWER.slice(group.excerptStart, group.excerptEnd));
			const html = renderToStaticMarkup(<>{highlightExcerpt(group)}</>);
			expect(html.replace(/<\/?mark[^>]*>/g, "")).toBe(renderToStaticMarkup(<>{group.text}</>));
		}
	});
});
