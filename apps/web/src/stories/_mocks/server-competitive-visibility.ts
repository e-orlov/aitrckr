/**
 * Mock for @/server/competitive-visibility used in Storybook stories. The real
 * module loads through pg, which is not browser-safe. Stories set the response
 * (or a pending / failing one) via setMockCompetitiveVisibility(); the real
 * useCompetitiveVisibility hook calls this through react-query.
 */
import type { CompetitiveVisibilityResponse } from "@/server/competitive-visibility";

export type { CompetitiveVisibilityResponse } from "@/server/competitive-visibility";

let _response: () => Promise<CompetitiveVisibilityResponse> = () => Promise.reject(new Error("no mock set"));

export function setMockCompetitiveVisibility(
	data: CompetitiveVisibilityResponse | (() => Promise<CompetitiveVisibilityResponse>),
) {
	_response = typeof data === "function" ? data : () => Promise.resolve(data);
}

export const getCompetitiveVisibilityFn = async (..._args: unknown[]) => _response();
