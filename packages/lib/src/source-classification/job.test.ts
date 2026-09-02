import { describe, expect, it, vi } from "vitest";

// job.ts's default deps pull in the drizzle client; neutralize it so this test
// runs with no database. Every dep used below is injected explicitly.
vi.mock("../db/db", () => ({ db: {} }));

import type { SourceDomainClassificationRecord } from "../db/schema";
import { runSourceClassificationJob } from "./job";
import { SOURCE_CLASSIFIER_VERSION, type SourceClassification } from "./types";

const payload = (overrides: Record<string, unknown> = {}) => ({
	hostname: "unknown-source.de",
	classifierVersion: SOURCE_CLASSIFIER_VERSION,
	builtInCategory: "other" as const,
	...overrides,
});

const classification: SourceClassification = {
	hostname: "unknown-source.de",
	category: "institutional",
	confidence: 0.91,
	reason: "consumer-protection institution",
	provider: "fake-provider",
	model: "fake-model",
	classifierVersion: SOURCE_CLASSIFIER_VERSION,
};

function deps(overrides: Record<string, unknown> = {}) {
	return {
		getCurrent: vi.fn(async () => new Map<string, SourceDomainClassificationRecord>()),
		classify: vi.fn(async () => classification),
		persist: vi.fn(async () => {}),
		...overrides,
	};
}

describe("runSourceClassificationJob", () => {
	// F05-IT-001 — success persists one validated row with the fake's metadata.
	it("classifies and persists an eligible hostname", async () => {
		const d = deps();
		const outcome = await runSourceClassificationJob(payload(), d);
		expect(outcome).toEqual({ status: "classified", classification });
		expect(d.persist).toHaveBeenCalledTimes(1);
		expect(d.persist).toHaveBeenCalledWith(classification);
	});

	// F05-IT-003 / F05-IT-006 — a duplicate or racing job re-checks the cache and
	// makes no provider call; a valid cached "other" also suppresses the call.
	it("skips the provider call when a current-version row already exists", async () => {
		const cached = new Map([["unknown-source.de", { category: "other" } as SourceDomainClassificationRecord]]);
		const d = deps({ getCurrent: vi.fn(async () => cached) });
		const outcome = await runSourceClassificationJob(payload(), d);
		expect(outcome).toEqual({ status: "cached" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(d.persist).not.toHaveBeenCalled();
	});

	// F05-IT-007 / F05-UT-009 — a stale-version job is skipped; a current-version
	// job with no current row (stale cache row) classifies once and persists.
	it("skips a job carrying a stale classifier version", async () => {
		const d = deps();
		const outcome = await runSourceClassificationJob(payload({ classifierVersion: "f05-v0" }), d);
		expect(outcome).toMatchObject({ status: "skipped" });
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("classifies again when the cache holds no current-version row (version bump replacement path)", async () => {
		// getCurrent filters by current version, so a stale row is equivalent to no row.
		const d = deps();
		const outcome = await runSourceClassificationJob(payload(), d);
		expect(outcome).toMatchObject({ status: "classified" });
		expect(d.classify).toHaveBeenCalledTimes(1);
		expect(d.persist).toHaveBeenCalledTimes(1);
	});

	// F05-UT-011 (worker side) — a payload whose built-in category is not "other"
	// never reaches the provider.
	it("rejects payloads whose built-in category is not other, without a provider call", async () => {
		const d = deps();
		const outcome = await runSourceClassificationJob(payload({ builtInCategory: "editorial" }), d);
		expect(outcome).toMatchObject({ status: "skipped" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(d.persist).not.toHaveBeenCalled();
	});

	it("rejects malformed payloads without a provider call", async () => {
		const d = deps();
		for (const bad of [null, {}, { hostname: "x.de" }, payload({ extra: "field" }), payload({ hostname: 42 })]) {
			const outcome = await runSourceClassificationJob(bad, d);
			expect(outcome).toMatchObject({ status: "skipped" });
		}
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("skips without a provider call when the hostname is no longer domain-level other", async () => {
		// wikipedia.org is deterministically "reference" — the global re-check catches it.
		const d = deps();
		const outcome = await runSourceClassificationJob(payload({ hostname: "wikipedia.org" }), d);
		expect(outcome).toMatchObject({ status: "skipped", reason: "hostname is no longer domain-level other" });
		expect(d.classify).not.toHaveBeenCalled();
	});

	// F05-IT-002 / F05-AT-008 — provider or validation failure propagates (bounded
	// queue retry) and persists nothing; a failure is never stored as "other".
	it("propagates classifier errors and persists nothing", async () => {
		const d = deps({
			classify: vi.fn(async () => {
				throw new Error("provider timeout");
			}),
		});
		await expect(runSourceClassificationJob(payload(), d)).rejects.toThrow("provider timeout");
		expect(d.persist).not.toHaveBeenCalled();
	});

	it("propagates persistence errors so the queue can retry", async () => {
		const d = deps({
			persist: vi.fn(async () => {
				throw new Error("db unavailable");
			}),
		});
		await expect(runSourceClassificationJob(payload(), d)).rejects.toThrow("db unavailable");
	});
});
