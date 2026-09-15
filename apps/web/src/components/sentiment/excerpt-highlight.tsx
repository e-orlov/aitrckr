/**
 * The pure highlight renderer for one excerpt group, kept free of hooks and
 * server imports so it can be exercised in unit and integration tests
 * without an app environment.
 */
import type { ReactNode } from "react";
import type { ExcerptGroup } from "@/lib/sentiment-excerpts";

const POLARITY_LABEL: Record<string, string> = { positive: "positive", negative: "negative", neutral: "neutral" };

/**
 * Wrap the highlights of one excerpt group in `<mark>` using their raw
 * offsets mapped onto the group (`start - excerptStart`). Every highlight is
 * an exact slice of the stored answer and lies inside its group by
 * construction, so the marked text is the cited text — nothing is searched
 * or re-derived from normalized text.
 */
export function highlightExcerpt(group: ExcerptGroup): ReactNode[] {
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const highlight of group.highlights) {
		const start = highlight.start - group.excerptStart;
		const end = highlight.end - group.excerptStart;
		if (start > cursor) parts.push(group.text.slice(cursor, start));
		parts.push(
			<mark
				key={`${highlight.start}-${highlight.end}`}
				className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
				data-polarity={highlight.polarities.join(",")}
				title={`Cited evidence (${highlight.polarities.map((p) => POLARITY_LABEL[p] ?? p).join(" and ")})`}
			>
				{group.text.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	if (cursor < group.text.length) parts.push(group.text.slice(cursor));
	return parts;
}
