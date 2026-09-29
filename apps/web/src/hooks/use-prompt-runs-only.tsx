import { useQuery } from "@tanstack/react-query";
import { getPromptRunFn, getPromptRunsFn } from "@/server/prompts";

export const promptRunsKeys = {
	all: ["prompt-runs"] as const,
	list: (promptId: string, options: { page: number; limit: number; days: number }) =>
		[...promptRunsKeys.all, promptId, options] as const,
};

/** A single run addressed by a deep link (`?tab=responses&run=<id>`), independent of the page it would fall on. */
export function usePromptRun(promptId: string | undefined, runId: string | undefined) {
	const query = useQuery({
		queryKey: [...promptRunsKeys.all, "one", promptId ?? "", runId ?? ""] as const,
		queryFn: () => getPromptRunFn({ data: { promptId: promptId as string, runId: runId as string } }),
		enabled: !!promptId && !!runId,
		staleTime: 60_000,
		retry: false,
	});
	return { run: query.data ?? null, isLoading: query.isLoading, isError: query.isError };
}

export function usePromptRunsOnly(promptId?: string, options?: { page?: number; limit?: number; days?: number }) {
	const page = options?.page || 1;
	const limit = options?.limit || 10;
	const days = options?.days || 7;

	const query = useQuery({
		queryKey: promptRunsKeys.list(promptId || "", { page, limit, days }),
		queryFn: () => getPromptRunsFn({ data: { promptId: promptId!, page, limit, days } }),
		enabled: !!promptId,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		placeholderData: (prev) => prev,
	});

	const total = Number(query.data?.total || 0);
	const totalPages = Math.ceil(total / limit) || 1;

	return {
		runs: query.data?.runs || [],
		total,
		hasMore: query.data?.hasMore || false,
		isLoading: query.isLoading,
		isError: query.error,
		revalidate: query.refetch,
		// Pagination object matching Next.js hook shape
		pagination: query.data
			? {
					page,
					limit,
					total,
					totalPages,
					hasNext: page < totalPages,
					hasPrev: page > 1,
				}
			: undefined,
	};
}
