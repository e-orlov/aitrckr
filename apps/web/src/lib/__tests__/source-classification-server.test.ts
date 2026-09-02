import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the loader from the real cache store: record what it asks for and
// control what it gets back.
const storeState = vi.hoisted(() => ({
	calls: [] as string[][],
	result: new Map<string, "editorial" | "institutional">(),
	error: null as Error | null,
}));

vi.mock("@workspace/lib/source-classification", async (importOriginal) => {
	const original = await importOriginal<typeof import("@workspace/lib/source-classification")>();
	return {
		...original,
		getSupplementalDomainCategories: async (hostnames: string[]) => {
			storeState.calls.push(hostnames);
			if (storeState.error) throw storeState.error;
			return storeState.result;
		},
	};
});

import { loadSupplementalDomainLookup } from "@/lib/source-classification.server";

beforeEach(() => {
	storeState.calls = [];
	storeState.result = new Map();
	storeState.error = null;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// F05-IT-008 / F05-AT-013 / F05-NFR-001 — both read surfaces obtain the cache
// through this one loader: a single batched call over deduped normalized
// hostnames, never a per-citation query.
describe("loadSupplementalDomainLookup", () => {
	it("makes one batched call with deduped, normalized hostnames", async () => {
		storeState.result = new Map([["unknown-source.de", "institutional"]]);
		const lookup = await loadSupplementalDomainLookup([
			"unknown-source.de",
			"www.unknown-source.de",
			"UNKNOWN-SOURCE.de",
			"another.de",
			"not a domain",
		]);
		expect(storeState.calls).toHaveLength(1);
		expect([...storeState.calls[0]].sort()).toEqual(["another.de", "unknown-source.de"]);
		expect(lookup("unknown-source.de")).toBe("institutional");
		expect(lookup("www.unknown-source.de")).toBe("institutional"); // lookup normalizes too
		expect(lookup("another.de")).toBeUndefined();
	});

	it("skips the query entirely when no valid hostname is present", async () => {
		const lookup = await loadSupplementalDomainLookup(["not a domain", "localhost"]);
		expect(storeState.calls).toHaveLength(0);
		expect(lookup("anything.de")).toBeUndefined();
	});

	// F05-FR-013 — a cache outage degrades to built-in behavior, never breaks a page.
	it("returns an empty lookup when the cache read fails", async () => {
		storeState.error = new Error("db down");
		const lookup = await loadSupplementalDomainLookup(["unknown-source.de"]);
		expect(lookup("unknown-source.de")).toBeUndefined();
	});
});
