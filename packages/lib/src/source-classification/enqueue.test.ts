import { describe, expect, it, vi } from "vitest";

// The default cache filter reaches drizzle; neutralize the client — every test
// injects its own filter.
vi.mock("../db/db", () => ({ db: {} }));

import { enqueueSourceClassificationsBestEffort } from "./enqueue";
import { SOURCE_CLASSIFICATION_QUEUE, SOURCE_CLASSIFIER_VERSION, sourceClassificationSingletonKey } from "./types";

const none = new Set<string>();
const citation = (domain: string, url = `https://${domain}/`) => ({ domain, url, title: null });
const passthroughFilter = async (hostnames: string[]) => hostnames;

function sender(impl?: (hostname: string) => Promise<string | null>) {
	const send = vi.fn(async (_queue: string, data: { hostname: string }) =>
		impl ? impl(data.hostname) : `job-${data.hostname}`,
	);
	return { sender: { send }, send };
}

describe("enqueueSourceClassificationsBestEffort", () => {
	// F05-AT-004 / F05-IT-004 — unique eligible hostnames, one singleton-keyed job each.
	it("attempts one singleton-keyed job per unique eligible hostname and counts accepted ids", async () => {
		const { sender: s, send } = sender();
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [
				citation("unknown-a.de"),
				citation("www.unknown-a.de"),
				citation("unknown-b.de"),
				citation("wikipedia.org"), // deterministically known — still eligible, hint rides along
				citation("mybrand.com"), // brand — never enqueued
			],
			brandDomains: new Set(["mybrand.com"]),
			competitorDomains: none,
			sender: s,
			deps: { filterNeeded: passthroughFilter },
		});

		expect(result).toEqual({ attempted: 3, accepted: 3, deduplicated: 0, failed: 0 });
		expect(send).toHaveBeenCalledTimes(3);
		const wikipediaCall = send.mock.calls.find(
			(call) => (call as unknown as [string, { hostname: string }])[1].hostname === "wikipedia.org",
		) as unknown as [string, { hostname: string; deterministicHint?: string }];
		expect(wikipediaCall[1].deterministicHint).toBe("reference");
		const [queue, data, options] = send.mock.calls[0] as unknown as [
			string,
			{ hostname: string },
			{ singletonKey: string },
		];
		expect(queue).toBe(SOURCE_CLASSIFICATION_QUEUE);
		expect(options.singletonKey).toBe(sourceClassificationSingletonKey(data.hostname, SOURCE_CLASSIFIER_VERSION));
	});

	// F05-RC-AT-002 — a null send result is the exclusive queue policy
	// deduplicating; it must count as deduplicated, never as accepted.
	it("counts a null job id as deduplicated, not accepted", async () => {
		const { sender: s } = sender(async (hostname) => (hostname === "unknown-a.de" ? null : `job-${hostname}`));
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [citation("unknown-a.de"), citation("unknown-b.de")],
			brandDomains: none,
			competitorDomains: none,
			sender: s,
			deps: { filterNeeded: passthroughFilter },
		});
		expect(result).toEqual({ attempted: 2, accepted: 1, deduplicated: 1, failed: 0 });
	});

	// F05-RC-AT-003 / F05-AT-014 / F05-IT-005 — a partially failing send batch
	// keeps earlier successes, keeps attempting, and never throws.
	it("keeps accepted/deduplicated counts across a failing send and never throws", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { sender: s, send } = sender(async (hostname) => {
			if (hostname === "unknown-b.de") throw new Error("pg-boss unavailable");
			if (hostname === "unknown-c.de") return null;
			return `job-${hostname}`;
		});
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [
				citation("unknown-a.de"),
				citation("unknown-b.de"),
				citation("unknown-c.de"),
				citation("unknown-d.de"),
			],
			brandDomains: none,
			competitorDomains: none,
			sender: s,
			deps: { filterNeeded: passthroughFilter },
		});
		expect(result).toEqual({ attempted: 4, accepted: 2, deduplicated: 1, failed: 1 });
		expect(send).toHaveBeenCalledTimes(4);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	// F05-IT-006 — hostnames with a current-version cache row (incl. valid
	// "other") are not re-enqueued.
	it("skips hostnames the cache filter reports as already classified", async () => {
		const { sender: s, send } = sender();
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [citation("cached.de"), citation("fresh.de")],
			brandDomains: none,
			competitorDomains: none,
			sender: s,
			deps: { filterNeeded: async (hostnames) => hostnames.filter((h) => h !== "cached.de") },
		});
		expect(result).toEqual({ attempted: 1, accepted: 1, deduplicated: 0, failed: 0 });
		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0] as unknown as [string, { hostname: string }])[1].hostname).toBe("fresh.de");
	});

	it("never throws when the cache filter fails", async () => {
		const { sender: s, send } = sender();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [citation("unknown-a.de")],
			brandDomains: none,
			competitorDomains: none,
			sender: s,
			deps: {
				filterNeeded: async () => {
					throw new Error("db down");
				},
			},
		});
		expect(result).toEqual({ attempted: 0, accepted: 0, deduplicated: 0, failed: 0 });
		expect(send).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("does nothing for an empty or fully ineligible citation set", async () => {
		const { sender: s, send } = sender();
		const filterNeeded = vi.fn(passthroughFilter);
		expect(
			(
				await enqueueSourceClassificationsBestEffort({
					citations: [],
					brandDomains: none,
					competitorDomains: none,
					sender: s,
					deps: { filterNeeded },
				})
			).attempted,
		).toBe(0);
		expect(
			(
				await enqueueSourceClassificationsBestEffort({
					citations: [citation("mybrand.com"), citation("not a domain")],
					brandDomains: new Set(["mybrand.com"]),
					competitorDomains: none,
					sender: s,
					deps: { filterNeeded },
				})
			).attempted,
		).toBe(0);
		expect(filterNeeded).not.toHaveBeenCalled(); // no candidates -> no cache query
		expect(send).not.toHaveBeenCalled();
	});
});
