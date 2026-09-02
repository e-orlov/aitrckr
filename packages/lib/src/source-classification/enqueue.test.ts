import { describe, expect, it, vi } from "vitest";

// The default cache filter reaches drizzle; neutralize the client — every test
// injects its own filter.
vi.mock("../db/db", () => ({ db: {} }));

import { enqueueSourceClassificationsBestEffort } from "./enqueue";
import { SOURCE_CLASSIFICATION_QUEUE, SOURCE_CLASSIFIER_VERSION, sourceClassificationSingletonKey } from "./types";

const none = new Set<string>();
const citation = (domain: string, url = `https://${domain}/`) => ({ domain, url, title: null });

function sender() {
	const send = vi.fn(async () => "job-id");
	return { sender: { send }, send };
}

describe("enqueueSourceClassificationsBestEffort", () => {
	// F05-AT-004 / F05-IT-004 — unique eligible hostnames, one singleton-keyed job each.
	it("enqueues one singleton-keyed job per unique eligible hostname", async () => {
		const { sender: s, send } = sender();
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [
				citation("unknown-a.de"),
				citation("www.unknown-a.de"),
				citation("unknown-b.de"),
				citation("wikipedia.org"), // deterministic — never enqueued
				citation("mybrand.com"), // brand — never enqueued
			],
			brandDomains: new Set(["mybrand.com"]),
			competitorDomains: none,
			sender: s,
			deps: { filterNeeded: async (hostnames) => hostnames },
		});

		expect(result.enqueued).toBe(2);
		expect(send).toHaveBeenCalledTimes(2);
		const [queue, data, options] = send.mock.calls[0] as unknown as [
			string,
			{ hostname: string },
			{ singletonKey: string },
		];
		expect(queue).toBe(SOURCE_CLASSIFICATION_QUEUE);
		expect(options.singletonKey).toBe(sourceClassificationSingletonKey(data.hostname, SOURCE_CLASSIFIER_VERSION));
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
		expect(result.enqueued).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0] as unknown as [string, { hostname: string }])[1].hostname).toBe("fresh.de");
	});

	// F05-AT-014 / F05-IT-005 — a queue outage cannot fail the caller.
	it("never throws when the queue send fails", async () => {
		const send = vi.fn(async () => {
			throw new Error("pg-boss unavailable");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await enqueueSourceClassificationsBestEffort({
			citations: [citation("unknown-a.de")],
			brandDomains: none,
			competitorDomains: none,
			sender: { send },
			deps: { filterNeeded: async (hostnames) => hostnames },
		});
		expect(result.enqueued).toBe(0);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
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
		expect(result.enqueued).toBe(0);
		expect(send).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("does nothing for an empty or fully ineligible citation set", async () => {
		const { sender: s, send } = sender();
		const filterNeeded = vi.fn(async (hostnames: string[]) => hostnames);
		expect(
			(
				await enqueueSourceClassificationsBestEffort({
					citations: [],
					brandDomains: none,
					competitorDomains: none,
					sender: s,
					deps: { filterNeeded },
				})
			).enqueued,
		).toBe(0);
		expect(
			(
				await enqueueSourceClassificationsBestEffort({
					citations: [citation("wikipedia.org")],
					brandDomains: none,
					competitorDomains: none,
					sender: s,
					deps: { filterNeeded },
				})
			).enqueued,
		).toBe(0);
		expect(filterNeeded).not.toHaveBeenCalled(); // no candidates -> no cache query
		expect(send).not.toHaveBeenCalled();
	});
});
