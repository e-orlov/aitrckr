/**
 * "How do the AI engines describe you and your competitors?" Selected-period
 * sentiment for the brand and its tracked competitors: concentric rings, a
 * trend and a leaderboard whose rows open to the highest- and lowest-sentiment
 * answers. Controls: Tags, Lookback, Aspect, Sort — deliberately no prompt
 * search and no model selector; a stale `q` or `model` parameter in the URL
 * has no effect here.
 */
import { createFileRoute } from "@tanstack/react-router";
import type { SentimentSortKey } from "@workspace/lib/sentiment/metrics";
import { FilterBar } from "@/components/filter-bar";
import { FilterSection, PageHeader } from "@/components/page-header";
import { SentimentAspectDropdown, SentimentSortDropdown } from "@/components/sentiment/controls";
import { SentimentSection } from "@/components/sentiment/section";
import { useBrand } from "@/hooks/use-brands";
import { useListFilters } from "@/hooks/use-list-filters";
import { usePromptsSummary } from "@/hooks/use-prompts-summary";
import { browserTimezone } from "@/hooks/use-sentiment";
import { pageHead } from "@/lib/route-head";
import { coerceSentimentAspect, coerceSentimentSort, type SentimentAspectParam } from "@/lib/sentiment-search";

export const Route = createFileRoute("/_authed/app/org/$org/brand/$brand/sentiment")({
	staticData: { crumb: "Sentiment" },
	// Route-local keys ride beside the shared brand filters; unknown values fall back to the defaults.
	validateSearch: (search: Record<string, unknown>): { aspect?: SentimentAspectParam; sort?: SentimentSortKey } => {
		const aspect = coerceSentimentAspect(search.aspect);
		const sort = coerceSentimentSort(search.sort);
		return {
			...(aspect !== "overall" ? { aspect } : {}),
			...(sort !== "sentiment" ? { sort } : {}),
		};
	},
	head: pageHead({ title: "Sentiment", description: "How AI engines describe you and your competitors." }),
	component: SentimentPage,
});

function SentimentPage() {
	const { brandId } = Route.useRouteContext();
	const { org, brand: brandParam } = Route.useParams();
	const { aspect, sort } = Route.useSearch();
	const { lookback, tags } = useListFilters();
	const { brand } = useBrand(brandId);
	const trackedTargets = brand?.trackedTargets ?? [];
	const { promptsSummary } = usePromptsSummary(brandId, { lookback });
	const availableTags = promptsSummary?.availableTags ?? [];

	const infoContent = (
		<>
			<p className="mb-2">
				Sentiment measures how the AI answers portray each brand when they mention it, on a 0–100 scale where 50 is
				neutral. Positive and Negative Visibility show how often users encounter a favourable or unfavourable portrayal
				across all evaluated responses.
			</p>
			<p>
				Mixed is its own category: one answer with meaningful praise and criticism of the same brand. Pick an aspect to
				focus on price, coverage or service.
			</p>
		</>
	);

	return (
		<PageHeader
			title="Sentiment"
			subtitle="How AI engines describe you and your competitors when they mention you."
			infoContent={infoContent}
		>
			<FilterSection>
				<FilterBar
					availableTags={availableTags}
					trackedTargets={trackedTargets}
					showSearch={false}
					showModelSelector={false}
					extraControls={
						<>
							<SentimentAspectDropdown />
							<SentimentSortDropdown />
						</>
					}
				/>
			</FilterSection>
			<SentimentSection
				brandId={brandId}
				filters={{ lookback, tags, aspect: aspect ?? "overall", timezone: browserTimezone() }}
				sortKey={sort ?? "sentiment"}
				org={org}
				brand={brandParam}
			/>
		</PageHeader>
	);
}
