/**
 * The Sentiment page's own filter-bar controls, in the shared trigger look:
 * Aspect (Overall / Price / Coverage / Service / Other) and Sort. Both are
 * route-local URL state; the default value is dropped from the URL.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import type { SentimentSortKey } from "@workspace/lib/sentiment/metrics";
import { ArrowUpDown, Tags } from "lucide-react";
import { FilterTriggerButton } from "@/components/filter-bar";
import {
	coerceSentimentAspect,
	coerceSentimentSort,
	DEFAULT_SENTIMENT_ASPECT,
	DEFAULT_SENTIMENT_SORT,
	SENTIMENT_ASPECT_OPTIONS,
	SENTIMENT_SORT_OPTIONS,
	type SentimentAspectParam,
} from "@/lib/sentiment-search";

export function SentimentAspectDropdown() {
	const navigate = useNavigate();
	const selected = useSearch({
		strict: false,
		select: (s) => coerceSentimentAspect((s as { aspect?: unknown }).aspect),
	});
	const setAspect = (next: SentimentAspectParam) =>
		navigate({
			to: ".",
			search: (prev: Record<string, unknown>) => ({
				...prev,
				aspect: next === DEFAULT_SENTIMENT_ASPECT ? undefined : next,
			}),
			replace: true,
			resetScroll: false,
		});
	const label = SENTIMENT_ASPECT_OPTIONS.find((o) => o.value === selected)?.label ?? "Aspect";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<FilterTriggerButton
						icon={<Tags className="size-3.5" />}
						label={selected === DEFAULT_SENTIMENT_ASPECT ? "Aspect" : label}
						active={selected !== DEFAULT_SENTIMENT_ASPECT}
						data-testid="sentiment-aspect-trigger"
					/>
				}
			/>
			<DropdownMenuContent align="start" className="w-52">
				<DropdownMenuRadioGroup value={selected} onValueChange={(v) => setAspect(v as SentimentAspectParam)}>
					{SENTIMENT_ASPECT_OPTIONS.map((o) => (
						<DropdownMenuRadioItem key={o.value} value={o.value} className="cursor-pointer whitespace-nowrap">
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function SentimentSortDropdown() {
	const navigate = useNavigate();
	const selected = useSearch({ strict: false, select: (s) => coerceSentimentSort((s as { sort?: unknown }).sort) });
	const setSort = (next: SentimentSortKey) =>
		navigate({
			to: ".",
			search: (prev: Record<string, unknown>) => ({
				...prev,
				sort: next === DEFAULT_SENTIMENT_SORT ? undefined : next,
			}),
			replace: true,
			resetScroll: false,
		});
	const label = SENTIMENT_SORT_OPTIONS.find((o) => o.value === selected)?.label ?? "Sort";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<FilterTriggerButton
						icon={<ArrowUpDown className="size-3.5" />}
						label={selected === DEFAULT_SENTIMENT_SORT ? "Sort" : label}
						active={selected !== DEFAULT_SENTIMENT_SORT}
						data-testid="sentiment-sort-trigger"
					/>
				}
			/>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuRadioGroup value={selected} onValueChange={(v) => setSort(v as SentimentSortKey)}>
					{SENTIMENT_SORT_OPTIONS.map((o) => (
						<DropdownMenuRadioItem key={o.value} value={o.value} className="cursor-pointer whitespace-nowrap">
							{o.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
