/**
 * Visibility Leaderboard: the brand and every tracked competitor ranked by the
 * canonical run-based Visibility, with each brand's prompt coverage beside it.
 * Bars are on an absolute 0–100% scale (not relative to the leader) so the bar
 * and the percentage always agree.
 */
import { Badge } from "@workspace/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { ColHead } from "@/components/col-head";
import { colorFor, entityColorMap, formatPct } from "@/components/competitive-visibility/format";
import { SiteIcon } from "@/components/site-icon";
import type { CompetitiveVisibilityEntity, CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";

export const LEADERBOARD_TIPS = {
	visibility:
		"Percentage of eligible AI responses that mention this brand. Brands are measured independently, so the percentages do not need to add up to 100%.",
	visiblePrompts:
		"Number and percentage of evaluated prompts where this brand appeared in at least one eligible AI response. This is prompt coverage, not the run-based Visibility score.",
	evaluatedPrompts:
		"Distinct prompts with at least one eligible AI response in the selected period — the same set for every brand.",
};

export function CompetitiveVisibilityLeaderboard({
	series,
	entities,
	evaluatedPromptCount,
	domainFor,
}: {
	series: CompetitiveVisibilitySeries[];
	entities: CompetitiveVisibilityEntity[];
	evaluatedPromptCount: number;
	domainFor?: (name: string) => string | undefined;
}) {
	const colors = entityColorMap(series);
	return (
		<div className="overflow-x-auto">
			<Table data-testid="competitive-visibility-leaderboard">
				<TableHeader>
					<TableRow>
						<TableHead className="w-10">#</TableHead>
						<TableHead>Brand</TableHead>
						<TableHead className="w-[34%] min-w-[10rem]">
							<ColHead label="Visibility" tip={LEADERBOARD_TIPS.visibility} />
						</TableHead>
						<TableHead className="text-right whitespace-nowrap">
							<ColHead label="Visible prompts" tip={LEADERBOARD_TIPS.visiblePrompts} right />
						</TableHead>
						<TableHead className="text-right whitespace-nowrap">
							<ColHead label="Evaluated prompts" tip={LEADERBOARD_TIPS.evaluatedPrompts} right />
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{entities.map((e) => {
						const width = e.visibility === null ? 0 : Math.max(0, Math.min(100, e.visibility));
						return (
							<TableRow key={e.key} data-entity={e.key} className={e.isBrand ? "bg-muted/40" : undefined}>
								<TableCell className="text-muted-foreground tabular-nums">{e.rank}</TableCell>
								<TableCell className="font-medium">
									<span className="inline-flex max-w-[16rem] min-w-0 items-center gap-2">
										<SiteIcon domain={domainFor?.(e.name)} size="md" />
										<span className="truncate" title={e.name}>
											{e.name}
										</span>
										{e.isBrand && (
											<Badge variant="secondary" className="shrink-0 text-xs">
												You
											</Badge>
										)}
									</span>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-2">
										<div aria-hidden="true" className="bg-muted h-2 w-full overflow-hidden rounded-full">
											<div
												data-testid="visibility-bar-fill"
												className="h-full rounded-full"
												style={{ width: `${width}%`, backgroundColor: colorFor(colors, e.key) }}
											/>
										</div>
										<span className="tabular-nums text-sm w-10 text-right">{formatPct(e.visibility)}</span>
									</div>
								</TableCell>
								<TableCell className="text-right tabular-nums whitespace-nowrap">
									{evaluatedPromptCount === 0 ? (
										<span className="text-muted-foreground">—</span>
									) : (
										<>
											{e.visiblePromptCount}{" "}
											<span className="text-muted-foreground">({formatPct(e.coveragePercent)})</span>
										</>
									)}
								</TableCell>
								<TableCell className="text-right tabular-nums text-muted-foreground">
									{evaluatedPromptCount === 0 ? "—" : evaluatedPromptCount}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
