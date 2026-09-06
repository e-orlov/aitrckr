/**
 * Citation Structure: one Sankey of the brand's own-domain citations, from the
 * brand through configured domains and raw hostnames to page paths. The page
 * is intentionally just the title, the shared filters and that diagram.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { CitationStructureSankey, MIN_CHART_WIDTH } from "@/components/citation-structure-sankey";
import { ALL_MODELS_VALUE } from "@/components/filter-bar";
import { FilteredListShell } from "@/components/filtered-list-shell";
import { PageHeader } from "@/components/page-header";
import { useBrand } from "@/hooks/use-brands";
import { useCitationStructure } from "@/hooks/use-citation-structure";
import { useListFilters } from "@/hooks/use-list-filters";
import { useBrandParams } from "@/hooks/use-route-params";
import { getDaysFromLookback } from "@/lib/chart-utils";
import { pageHead } from "@/lib/route-head";

export const Route = createFileRoute("/_authed/app/org/$org/brand/$brand/citation-structure")({
	staticData: { crumb: "Citation Structure" },
	head: pageHead({
		description: "See how AI citations of your own domains split across hostnames and page paths.",
	}),
	component: CitationStructurePage,
});

function CitationStructurePage() {
	const brandParams = useBrandParams();
	const { brandId } = Route.useRouteContext();
	const filters = useListFilters();
	const days = getDaysFromLookback(filters.lookback);

	const { brand } = useBrand(brandId);
	const trackedTargets = brand?.trackedTargets ?? [];

	const { structure, isLoading, isError, refetch } = useCitationStructure(brandId, {
		days,
		tags: filters.tags.length > 0 ? filters.tags : undefined,
		model: filters.model === ALL_MODELS_VALUE ? undefined : filters.model,
	});

	// A brand without a configured owned domain has nothing to structure
	// whatever the filters say, so that case always lands on the empty state.
	const unconfigured = structure !== undefined && structure.ownedDomainCount === 0;
	const shellFilters = unconfigured ? { ...filters, isFiltered: false } : filters;

	const infoContent = (
		<>
			<p className="mb-2">
				Every citation of one of your own domains flows from your brand through the configured domain it belongs to, the
				exact hostname that was cited (so <code>www</code>, the apex and other subdomains stay apart) and finally the
				page path, with query strings and fragments folded together.
			</p>
			<p>
				The unit is citation occurrences: each citation stored for an enabled prompt counts once. Owned domains are your
				website and additional domains from{" "}
				<Link to="/app/org/$org/brand/$brand/settings/brand" params={brandParams} className="underline">
					Brand settings
				</Link>
				.
			</p>
		</>
	);

	return (
		<PageHeader
			title="Citation Structure"
			subtitle="How AI citations of your own domains split across hostnames and page paths."
			infoContent={infoContent}
		>
			<FilteredListShell
				filters={shellFilters}
				availableTags={structure?.availableTags ?? []}
				trackedTargets={trackedTargets}
				showModelSelector
				isLoading={isLoading && !structure}
				loadingState={
					<div className="overflow-x-auto" data-testid="citation-structure-loading">
						<div className="grid grid-cols-4 gap-8 h-[360px]" style={{ minWidth: MIN_CHART_WIDTH }}>
							<Skeleton className="h-full w-3" />
							<div className="space-y-6">
								<Skeleton className="h-2/5 w-3" />
								<Skeleton className="h-1/4 w-3" />
							</div>
							<div className="space-y-4">
								<Skeleton className="h-1/4 w-3" />
								<Skeleton className="h-1/6 w-3" />
								<Skeleton className="h-1/5 w-3" />
							</div>
							<div className="space-y-3">
								<Skeleton className="h-8 w-3" />
								<Skeleton className="h-8 w-3" />
								<Skeleton className="h-6 w-3" />
								<Skeleton className="h-6 w-3" />
								<Skeleton className="h-4 w-3" />
							</div>
						</div>
					</div>
				}
				isError={isError || (!isLoading && !structure)}
				errorState={
					<Card>
						<CardContent className="pt-6">
							<div
								role="alert"
								className="text-red-600 text-sm bg-red-50 p-3 rounded-md flex items-center justify-between gap-4"
							>
								<span>Failed to load the citation structure. Please try again.</span>
								<Button variant="outline" size="sm" onClick={() => refetch()}>
									Retry
								</Button>
							</div>
						</CardContent>
					</Card>
				}
				totalCount={unconfigured ? 0 : structure?.totalOwnedOccurrences}
				noMatchesTitle="No citations of your own domains match the selected filters."
				noMatchesDescription="Try another model or tag selection, or a longer time period."
				emptyState={
					<Card>
						<CardContent className="pt-6">
							<div className="text-muted-foreground text-center py-8">
								{unconfigured ? (
									<>
										No owned domain is configured for this brand. Add your website or additional domains in{" "}
										<Link
											to="/app/org/$org/brand/$brand/settings/brand"
											params={brandParams}
											className="underline text-foreground"
										>
											Brand settings
										</Link>
										.
									</>
								) : (
									"No citations of your own domains yet. They appear once AI answers to your prompts link to your website."
								)}
							</div>
						</CardContent>
					</Card>
				}
			>
				{structure && structure.totalOwnedOccurrences > 0 && (
					<CitationStructureSankey
						nodes={structure.nodes}
						links={structure.links}
						total={structure.totalOwnedOccurrences}
					/>
				)}
			</FilteredListShell>
		</PageHeader>
	);
}
