/**
 * The two evidence areas under an expanded leaderboard row: up to ten
 * highest- and ten lowest-sentiment answers for one entity, side by side on
 * wide screens and stacked on narrow ones. Each item shows the score and
 * category, the exact excerpt highlighted inside a short answer window, the
 * prompt, date and tags, aspect labels, the monitoring answer's own source
 * links (never classifier search results) and a deep link to the stored
 * response. No model, provider or classifier version is shown anywhere.
 */
import { Link } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { CATEGORY_STYLE, formatScore } from "@/components/sentiment/format";
import { type SentimentFilters, useSentimentEvidence } from "@/hooks/use-sentiment";
import type { SentimentAspectParam } from "@/lib/sentiment-search";
import type { SentimentEvidenceItem, SentimentEvidenceResponse } from "@/server/sentiment";

/**
 * Wrap the stored evidence spans in `<mark>` using their raw offsets mapped
 * onto the excerpt window (`start - excerptStart`), clipped to the window and
 * without overlapping. Nothing is re-searched by text, so an excerpt whose
 * stored form differs from the model's quote in whitespace or Unicode form
 * still highlights exactly the cited characters.
 */
export function highlightExcerpt(
	excerpt: string,
	spans: readonly { start: number; end: number }[],
	excerptStart: number,
): ReactNode[] {
	const ranges: [number, number][] = [];
	for (const span of spans) {
		const start = Math.max(0, span.start - excerptStart);
		const end = Math.min(excerpt.length, span.end - excerptStart);
		if (end > start) ranges.push([start, end]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start < cursor) continue;
		if (start > cursor) parts.push(excerpt.slice(cursor, start));
		parts.push(
			<mark
				key={`${start}-${end}`}
				className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
			>
				{excerpt.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	if (cursor < excerpt.length) parts.push(excerpt.slice(cursor));
	return parts;
}

function EvidenceCard({
	item,
	aspect,
	org,
	brand,
}: {
	item: SentimentEvidenceItem;
	aspect: SentimentAspectParam;
	org: string;
	brand: string;
}) {
	const style = CATEGORY_STYLE[item.category];
	const date = new Date(item.runCreatedAt).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
	return (
		<li className="rounded-lg border p-3 text-sm" data-testid="sentiment-evidence-item" data-run={item.promptRunId}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-base font-semibold tabular-nums">{formatScore(item.score)}</span>
				<span className={`text-xs font-medium ${style.className}`}>{style.label}</span>
				{aspect !== "overall" && (
					<Badge variant="outline" className="text-xs">
						{item.aspects.find((a) => a.key === aspect)?.label ?? aspect}
					</Badge>
				)}
				<span className="text-muted-foreground ml-auto text-xs">{date}</span>
			</div>
			<p
				className="text-muted-foreground mt-2 line-clamp-6 whitespace-pre-line text-xs leading-relaxed"
				data-testid="sentiment-evidence-excerpt"
			>
				{highlightExcerpt(item.excerpt, item.evidence, item.excerptStart)}
			</p>
			<p className="mt-2 truncate text-xs" title={item.promptText}>
				<span className="text-muted-foreground">Prompt: </span>
				{item.promptText}
			</p>
			{(item.tags.length > 0 || (aspect === "overall" && item.aspects.length > 0)) && (
				<div className="mt-2 flex flex-wrap gap-1">
					{item.tags.map((tag) => (
						<Badge key={`tag-${tag}`} variant="secondary" className="text-[10px]">
							{tag}
						</Badge>
					))}
					{aspect === "overall" &&
						item.aspects.map((a) => (
							<Badge
								key={`aspect-${a.key}`}
								variant="outline"
								className={`text-[10px] ${CATEGORY_STYLE[a.category].className}`}
							>
								{a.label}: {CATEGORY_STYLE[a.category].label} {formatScore(a.score)}
							</Badge>
						))}
				</div>
			)}
			<div
				className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
				data-testid="sentiment-evidence-sources"
			>
				{item.sources.length === 0 ? (
					<span className="text-muted-foreground">No cited sources</span>
				) : (
					item.sources.slice(0, 6).map((source) => (
						<a
							key={source.url}
							href={source.url}
							target="_blank"
							rel="noreferrer noopener"
							className="text-muted-foreground inline-flex max-w-[16rem] items-center gap-1 truncate underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
							title={source.title ?? source.url}
						>
							<ExternalLink className="size-3 shrink-0" aria-hidden="true" />
							<span className="truncate">{source.domain}</span>
						</a>
					))
				)}
				<Link
					to="/app/org/$org/brand/$brand/prompts/$promptId"
					params={{ org, brand, promptId: item.promptId }}
					search={{ tab: "responses", run: item.promptRunId }}
					className="ml-auto font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
					data-testid="sentiment-evidence-deep-link"
				>
					Full response
				</Link>
			</div>
		</li>
	);
}

function EvidenceColumn({
	heading,
	items,
	aspect,
	org,
	brand,
	testId,
}: {
	heading: string;
	items: SentimentEvidenceItem[];
	aspect: SentimentAspectParam;
	org: string;
	brand: string;
	testId: string;
}) {
	return (
		<section aria-label={heading} data-testid={testId} className="min-w-0">
			<h3 className="mb-2 text-sm font-medium">
				{heading} <span className="text-muted-foreground font-normal">({items.length})</span>
			</h3>
			{items.length === 0 ? (
				<p className="text-muted-foreground text-xs">No answers in this set.</p>
			) : (
				<ul className="grid gap-2">
					{items.map((item) => (
						<EvidenceCard key={item.observationId} item={item} aspect={aspect} org={org} brand={brand} />
					))}
				</ul>
			)}
		</section>
	);
}

/** Presentation only: the empty state or the two columns for a loaded evidence response. */
export function SentimentEvidenceColumns({
	data,
	aspect,
	org,
	brand,
}: {
	data: SentimentEvidenceResponse;
	aspect: SentimentAspectParam;
	org: string;
	brand: string;
}) {
	if (data.totalObservations === 0) {
		return (
			<p className="text-muted-foreground text-sm" data-testid="sentiment-evidence-empty">
				No analyzed mentions of {data.entity.name} in the selected scope yet.
			</p>
		);
	}
	return (
		<div className="grid gap-4 md:grid-cols-2" data-testid="sentiment-evidence" data-total={data.totalObservations}>
			<EvidenceColumn
				heading="Highest sentiment"
				items={data.highest}
				aspect={aspect}
				org={org}
				brand={brand}
				testId="sentiment-evidence-highest"
			/>
			<EvidenceColumn
				heading="Lowest sentiment"
				items={data.lowest}
				aspect={aspect}
				org={org}
				brand={brand}
				testId="sentiment-evidence-lowest"
			/>
		</div>
	);
}

export function SentimentEvidencePanels({
	brandId,
	entityKey,
	filters,
	org,
	brand,
}: {
	brandId: string;
	entityKey: string;
	filters: SentimentFilters;
	org: string;
	brand: string;
}) {
	const { data, isLoading, isError, refetch } = useSentimentEvidence(brandId, entityKey, filters);
	if (isLoading && !data) {
		return (
			<div className="grid gap-4 md:grid-cols-2" data-testid="sentiment-evidence-loading">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-24 w-full" />
			</div>
		);
	}
	if (isError || !data) {
		return (
			<div className="flex items-center gap-3 text-sm" role="alert">
				<span className="text-destructive">Could not load the evidence for this row.</span>
				<Button type="button" size="sm" variant="outline" onClick={() => refetch()}>
					Retry
				</Button>
			</div>
		);
	}
	return <SentimentEvidenceColumns data={data} aspect={filters.aspect} org={org} brand={brand} />;
}
