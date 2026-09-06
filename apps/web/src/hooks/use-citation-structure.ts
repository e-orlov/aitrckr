import { useQuery } from "@tanstack/react-query";
import { useResolvedBrandId } from "@/hooks/use-brand-id";
import { getCitationStructureFn } from "@/server/citation-structure";

export interface CitationStructureFilters {
	days: number;
	tags?: string[];
	model?: string;
}

/** Tag order never changes the result, so the key sorts them: `a,b` and `b,a` share one cache entry. */
function normalizeTags(tags: string[] | undefined): string | undefined {
	const cleaned = [...new Set((tags ?? []).filter(Boolean))].sort();
	return cleaned.length > 0 ? cleaned.join(",") : undefined;
}

export const citationStructureKeys = {
	all: ["citation-structure"] as const,
	view: (brandId: string, days: number, tags: string | undefined, model: string | undefined) =>
		[...citationStructureKeys.all, brandId, { days, tags, model }] as const,
};

export function useCitationStructure(brandId: string | undefined, filters: CitationStructureFilters) {
	const resolvedBrandId = useResolvedBrandId(brandId);
	const tags = normalizeTags(filters.tags);
	const model = filters.model || undefined;

	const query = useQuery({
		queryKey: citationStructureKeys.view(resolvedBrandId || "", filters.days, tags, model),
		queryFn: () =>
			getCitationStructureFn({
				data: { brandId: resolvedBrandId as string, days: filters.days, tags, model },
			}),
		enabled: !!resolvedBrandId,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		refetchInterval: 60_000,
		placeholderData: (prev) => prev,
	});

	return {
		structure: query.data,
		isLoading: query.isLoading,
		isFetching: query.isFetching,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
	};
}
