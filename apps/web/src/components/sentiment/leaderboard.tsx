/**
 * Every active competitor and the brand, sortable by the approved metrics,
 * with the sample size beside every score. One row expands at a time to the
 * highest/lowest evidence areas (loaded lazily by the panel component).
 */
import { Badge } from "@workspace/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { ColHead } from "@/components/col-head";
import {
	CATEGORY_ORDER,
	CATEGORY_STYLE,
	colorFor,
	entityColorMap,
	formatMentionCount,
	formatPct,
	formatScore,
} from "@/components/sentiment/format";
import { SiteIcon } from "@/components/site-icon";
import type { SentimentEntityRow } from "@/server/sentiment";

export const LEADERBOARD_TIPS = {
	sentiment:
		"Mean score (0–100, 50 = neutral) over this brand's analyzed mentions in the selected period. The count beside it is the sample: analyzed of total mentions.",
	mentionVisibility: "Share of the evaluated responses that mention this brand.",
	positiveVisibility: "Share of the evaluated responses in which this brand is portrayed positively.",
	negativeVisibility: "Share of the evaluated responses in which this brand is portrayed negatively.",
	distribution:
		"Positive / Neutral / Mixed / Negative shares of the analyzed mentions. Mixed means one answer contains meaningful praise and criticism of this brand.",
	coverage: "Share of this brand's mentions that the current analysis has classified.",
	responses: "Evaluated responses in the selected period (the denominator of every visibility metric).",
} as const;

function Distribution({ row }: { row: SentimentEntityRow }) {
	if (row.classified === 0) return <span className="text-muted-foreground text-xs">—</span>;
	const text = CATEGORY_ORDER.map((c) => `${CATEGORY_STYLE[c].label} ${row.counts[c]}`).join(", ");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<div
						className="flex h-2 w-full min-w-[6rem] cursor-help overflow-hidden rounded-full bg-muted"
						role="img"
						aria-label={text}
					/>
				}
			>
				{CATEGORY_ORDER.map((c) => (
					<span
						key={c}
						className={`h-full ${CATEGORY_STYLE[c].bar}`}
						style={{ width: `${(row.counts[c] / row.classified) * 100}%` }}
						aria-hidden="true"
					/>
				))}
			</TooltipTrigger>
			<TooltipContent className="text-xs">
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
					{CATEGORY_ORDER.map((c) => (
						<div key={c} className="contents">
							<dt className={CATEGORY_STYLE[c].className}>{CATEGORY_STYLE[c].label}</dt>
							<dd className="text-right font-mono">
								{row.counts[c]} ({formatPct((row.counts[c] / row.classified) * 100)})
							</dd>
						</div>
					))}
				</dl>
			</TooltipContent>
		</Tooltip>
	);
}

export function SentimentLeaderboard({
	rows,
	chartRoster,
	eligibleResponses,
	expandedKey,
	onToggle,
	domainFor,
	renderExpanded,
}: {
	/** Already sorted by the caller. */
	rows: readonly SentimentEntityRow[];
	chartRoster: readonly string[];
	eligibleResponses: number;
	expandedKey: string | null;
	onToggle: (key: string) => void;
	domainFor: (name: string) => string | undefined;
	renderExpanded: (row: SentimentEntityRow) => ReactNode;
}) {
	const colors = entityColorMap(chartRoster);
	const onKey = (event: KeyboardEvent, key: string) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onToggle(key);
		}
	};
	return (
		<Table data-testid="sentiment-leaderboard">
			<TableHeader>
				<TableRow>
					<TableHead className="w-8" />
					<TableHead className="w-10">#</TableHead>
					<TableHead>Brand</TableHead>
					<TableHead>
						<ColHead label="Sentiment" tip={LEADERBOARD_TIPS.sentiment} />
					</TableHead>
					<TableHead className="text-right">
						<ColHead label="Mention Visibility" tip={LEADERBOARD_TIPS.mentionVisibility} right />
					</TableHead>
					<TableHead className="text-right">
						<ColHead label="Positive Visibility" tip={LEADERBOARD_TIPS.positiveVisibility} right />
					</TableHead>
					<TableHead className="text-right">
						<ColHead label="Negative Visibility" tip={LEADERBOARD_TIPS.negativeVisibility} right />
					</TableHead>
					<TableHead className="w-[14%]">
						<ColHead label="Distribution" tip={LEADERBOARD_TIPS.distribution} />
					</TableHead>
					<TableHead className="text-right">
						<ColHead label="Coverage" tip={LEADERBOARD_TIPS.coverage} right />
					</TableHead>
					<TableHead className="text-right">
						<ColHead label="Responses" tip={LEADERBOARD_TIPS.responses} right />
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row, index) => {
					const expanded = expandedKey === row.key;
					const panelId = `sentiment-evidence-${row.key}`;
					return [
						<TableRow
							key={row.key}
							role="button"
							tabIndex={0}
							aria-expanded={expanded}
							aria-controls={panelId}
							onClick={() => onToggle(row.key)}
							onKeyDown={(event) => onKey(event, row.key)}
							data-testid="sentiment-leaderboard-row"
							data-entity={row.key}
							className={`cursor-pointer focus-visible:outline-2 focus-visible:outline-ring ${row.isBrand ? "bg-muted/40" : ""}`}
						>
							<TableCell className="text-muted-foreground">
								{expanded ? (
									<ChevronDown className="size-4" aria-hidden="true" />
								) : (
									<ChevronRight className="size-4" aria-hidden="true" />
								)}
							</TableCell>
							<TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
							<TableCell className="font-medium">
								<span className="inline-flex items-center gap-2">
									<span
										aria-hidden="true"
										className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
										style={{ background: colorFor(colors, row.key) }}
									/>
									<SiteIcon domain={domainFor(row.name)} size="md" />
									{row.name}
									{row.isBrand && (
										<Badge variant="secondary" className="text-xs">
											You
										</Badge>
									)}
								</span>
							</TableCell>
							<TableCell className="whitespace-nowrap tabular-nums" data-testid="sentiment-cell">
								<span className="font-mono text-base font-semibold">{formatScore(row.metrics.sentiment)}</span>
								<span className="text-muted-foreground text-xs"> · {formatMentionCount(row)}</span>
								{row.lowSample && (
									<Badge variant="outline" className="ml-2 text-[10px]" title="Fewer than five analyzed mentions">
										Low sample
									</Badge>
								)}
								{row.metrics.partial && row.classified > 0 && (
									<Badge variant="outline" className="ml-2 text-[10px]">
										Partial
									</Badge>
								)}
							</TableCell>
							<TableCell className="text-right tabular-nums">{formatPct(row.metrics.mentionVisibility)}</TableCell>
							<TableCell className="text-right tabular-nums">{formatPct(row.metrics.positiveVisibility)}</TableCell>
							<TableCell className="text-right tabular-nums">{formatPct(row.metrics.negativeVisibility)}</TableCell>
							<TableCell>
								<Distribution row={row} />
							</TableCell>
							<TableCell className="text-right tabular-nums text-muted-foreground">
								{formatPct(row.metrics.analysisCoverage)}
							</TableCell>
							<TableCell className="text-right tabular-nums text-muted-foreground">
								{eligibleResponses.toLocaleString()}
							</TableCell>
						</TableRow>,
						expanded ? (
							<TableRow key={`${row.key}-evidence`} className="hover:bg-transparent">
								<TableCell colSpan={10} id={panelId} className="bg-muted/20 p-4" data-testid="sentiment-expanded">
									{renderExpanded(row)}
								</TableCell>
							</TableRow>
						) : null,
					];
				})}
			</TableBody>
		</Table>
	);
}
