/**
 * The visible list beside a summary chart: one semantic row per entity or
 * category with its colour, label, optional badge and a display-ready value.
 * Presentation only — callers decide order, colours, formatting and emphasis;
 * this component never sorts, rounds, sums or infers anything from a label.
 */
import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

export type MetricLegendEmphasis = "primary" | "default" | "muted";

export interface MetricLegendItem {
	/** Stable identity used as the React key and `data-entity`; independent of the label. */
	readonly id: string;
	readonly label: string;
	/** Any CSS colour; painted on the decorative dot. */
	readonly color: string;
	/** Fully formatted text (e.g. "44%", "3 of 7", "—"); rendered verbatim. */
	readonly valueLabel: string;
	readonly emphasis?: MetricLegendEmphasis;
	/** Optional badge after the label, e.g. "You" for the own brand. */
	readonly badgeLabel?: string;
	/** Hover/accessible title when the visible label may truncate; defaults to `label`. */
	readonly title?: string;
}

export interface MetricLegendProps {
	readonly items: readonly MetricLegendItem[];
	/** Accessible name of the list, e.g. "Brands" or "Categories". */
	readonly ariaLabel: string;
	readonly className?: string;
	readonly testId?: string;
}

const LABEL_CLASS: Record<MetricLegendEmphasis, string> = {
	primary: "font-medium",
	default: "",
	muted: "text-muted-foreground",
};

export function MetricLegend({ items, ariaLabel, className, testId }: MetricLegendProps) {
	return (
		<ul aria-label={ariaLabel} data-testid={testId} className={cn("min-w-0 grid gap-1 text-xs", className)}>
			{items.map((item) => {
				const emphasis = item.emphasis ?? "default";
				return (
					<li key={item.id} className="flex min-w-0 items-center gap-2" data-entity={item.id}>
						<span
							aria-hidden="true"
							className={cn("shrink-0 rounded-full", emphasis === "primary" ? "h-3 w-3" : "h-2.5 w-2.5")}
							style={{ background: item.color }}
						/>
						<span className={cn("min-w-0 truncate", LABEL_CLASS[emphasis])} title={item.title ?? item.label}>
							{item.label}
						</span>
						{item.badgeLabel !== undefined && (
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								{item.badgeLabel}
							</Badge>
						)}
						<span className="ml-auto shrink-0 pl-2 whitespace-nowrap font-mono tabular-nums">{item.valueLabel}</span>
					</li>
				);
			})}
		</ul>
	);
}
