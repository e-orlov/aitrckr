import { useQuery } from "@tanstack/react-query";
import { useResolvedBrandId } from "@/hooks/use-brand-id";
import type { LookbackPeriod } from "@/lib/chart-utils";
import type { SentimentAspectParam } from "@/lib/sentiment-search";
import { getSentimentEvidenceFn, getSentimentOverviewFn, SENTIMENT_EVIDENCE_LIMIT } from "@/server/sentiment";

export interface SentimentFilters {
	lookback: LookbackPeriod;
	/** Tag filter (resolved to prompt ids server-side). */
	tags?: string[];
	aspect: SentimentAspectParam;
	timezone: string;
}

/**
 * Every parameter that changes the result is in the key, in one canonical
 * shape. Deliberately no search term and no model: the page has neither.
 */
export const sentimentKeys = {
	all: ["sentiment"] as const,
	overview: (brandId: string, f: SentimentFilters) =>
		[
			...sentimentKeys.all,
			"overview",
			brandId,
			f.lookback,
			[...(f.tags ?? [])].sort().join(","),
			f.aspect,
			f.timezone,
		] as const,
	evidence: (brandId: string, entityKey: string, f: SentimentFilters) =>
		[
			...sentimentKeys.all,
			"evidence",
			brandId,
			entityKey,
			f.lookback,
			[...(f.tags ?? [])].sort().join(","),
			f.aspect,
			f.timezone,
		] as const,
};

export function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const tagsParam = (tags?: string[]) => (tags && tags.length > 0 ? tags.join(",") : undefined);

export function useSentimentOverview(brandId: string | undefined, filters: SentimentFilters) {
	const resolvedBrandId = useResolvedBrandId(brandId);
	const query = useQuery({
		queryKey: sentimentKeys.overview(resolvedBrandId ?? "", filters),
		queryFn: () =>
			getSentimentOverviewFn({
				data: {
					brandId: resolvedBrandId as string,
					lookback: filters.lookback,
					tags: tagsParam(filters.tags),
					aspect: filters.aspect,
					timezone: filters.timezone,
				},
			}),
		enabled: !!resolvedBrandId,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
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

/** Loaded only while a leaderboard row is expanded (`enabled`). */
export function useSentimentEvidence(brandId: string | undefined, entityKey: string | null, filters: SentimentFilters) {
	const resolvedBrandId = useResolvedBrandId(brandId);
	const query = useQuery({
		queryKey: sentimentKeys.evidence(resolvedBrandId ?? "", entityKey ?? "", filters),
		queryFn: () =>
			getSentimentEvidenceFn({
				data: {
					brandId: resolvedBrandId as string,
					entityKey: entityKey as string,
					lookback: filters.lookback,
					tags: tagsParam(filters.tags),
					aspect: filters.aspect,
					timezone: filters.timezone,
					limit: SENTIMENT_EVIDENCE_LIMIT,
				},
			}),
		enabled: !!resolvedBrandId && !!entityKey,
		staleTime: 30_000,
	});
	return {
		data: query.data,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
	};
}
