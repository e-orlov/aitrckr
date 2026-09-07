import { useQuery } from "@tanstack/react-query";
import { useResolvedBrandId } from "@/hooks/use-brand-id";
import type { LookbackPeriod } from "@/lib/chart-utils";
import { getCompetitiveVisibilityFn } from "@/server/competitive-visibility";

export interface CompetitiveVisibilityFilters {
	lookback: LookbackPeriod;
	model?: string;
	/** Tag filter (resolved to prompt IDs server-side). */
	tags?: string[];
	/** Search term applied to prompt text (resolved server-side) — part of the Visibility page's scope. */
	search?: string;
	timezone: string;
}

/** Every parameter that changes the result is in the key, in one canonical shape. */
export const competitiveVisibilityKeys = {
	all: ["competitive-visibility"] as const,
	scope: (brandId: string, f: CompetitiveVisibilityFilters) =>
		[
			...competitiveVisibilityKeys.all,
			brandId,
			f.lookback,
			f.model ?? null,
			[...(f.tags ?? [])].sort().join(","),
			f.search ?? "",
			f.timezone,
		] as const,
};

export function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useCompetitiveVisibility(brandId: string | undefined, filters: CompetitiveVisibilityFilters) {
	const resolvedBrandId = useResolvedBrandId(brandId);

	const query = useQuery({
		queryKey: competitiveVisibilityKeys.scope(resolvedBrandId ?? "", filters),
		queryFn: () =>
			getCompetitiveVisibilityFn({
				data: {
					brandId: resolvedBrandId as string,
					lookback: filters.lookback,
					model: filters.model,
					tags: filters.tags && filters.tags.length > 0 ? filters.tags.join(",") : undefined,
					search: filters.search || undefined,
					timezone: filters.timezone,
				},
			}),
		enabled: !!resolvedBrandId,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		// Keep the previous scope's payload only as a layout placeholder; the
		// section reads `isPlaceholderData` to avoid presenting it as current.
		placeholderData: (prev) => prev,
	});

	return {
		data: query.data,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isPlaceholderData: query.isPlaceholderData,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
	};
}
