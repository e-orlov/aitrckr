/**
 * Mock for @/server/citation-structure used in Storybook stories. The real
 * module reads through pg, which is not browser-safe. Stories set the response
 * (or a pending / failing one) via setMockCitationStructure(); the real
 * useCitationStructure hook calls this through react-query.
 */
import type { CitationStructureResult } from "@/server/citation-structure";

export type { CitationStructureResult } from "@/server/citation-structure";

let _response: () => Promise<CitationStructureResult> = () => Promise.reject(new Error("no mock set"));

export function setMockCitationStructure(data: CitationStructureResult | (() => Promise<CitationStructureResult>)) {
	_response = typeof data === "function" ? data : () => Promise.resolve(data);
}

export const getCitationStructureFn = async (..._args: unknown[]) => _response();
