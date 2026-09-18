import { describe, expect, it, vi } from "vitest";
import type { SentimentAnalysis } from "../../db/schema";
import { runSentimentJob } from "../job";
import { isAnalysisCurrent, isAnalysisTerminallyFailed } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_READABLE_CLASSIFIER_VERSIONS,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentSingletonKey,
} from "../types";

/**
 * CP7 — v3 and v4 cannot collide: a completed v3 analysis leaves the run
 * eligible for v4, a completed v4 analysis does not; the two versions have
 * distinct queue identities; a stale-version payload is skipped without a
 * call; v3 rows are never written by the v4 job.
 */
const RUN = "5e970009-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

function row(patch: Partial<SentimentAnalysis>): SentimentAnalysis {
	return {
		id: "an-1",
		promptRunId: RUN,
		brandId: "arag",
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: HASH,
		status: "completed",
		provider: null,
		model: null,
		webSearch: false,
		errorCode: null,
		errorMessage: null,
		attempts: 1,
		claimGeneration: 1,
		startedAt: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...patch,
	} as SentimentAnalysis;
}

describe("classifier v3/v4 coexistence", () => {
	it("the current version is v5; v4 and then v3 are the only fallbacks", () => {
		expect(SENTIMENT_CLASSIFIER_VERSION).toBe("sent-classifier-v5");
		expect(SENTIMENT_READABLE_CLASSIFIER_VERSIONS).toEqual([
			"sent-classifier-v5",
			"sent-classifier-v4",
			"sent-classifier-v3",
		]);
	});

	it("a completed v3 analysis does not make the run current; a completed v4 analysis does", () => {
		expect(isAnalysisCurrent(row({ classifierVersion: "sent-classifier-v3" }), HASH)).toBe(false);
		expect(isAnalysisCurrent(row({}), HASH)).toBe(true);
		expect(isAnalysisCurrent(row({ inputHash: "b".repeat(64) }), HASH)).toBe(false);
	});

	it("a terminal v3 failure does not block a v4 attempt; a terminal v4 failure does", () => {
		const failed = { status: "failed" as const, errorCode: "mixed-needs-dual-evidence" };
		expect(isAnalysisTerminallyFailed(row({ ...failed, classifierVersion: "sent-classifier-v3" }), HASH)).toBe(false);
		expect(isAnalysisTerminallyFailed(row({ ...failed }), HASH)).toBe(true);
		expect(isAnalysisTerminallyFailed(row({ ...failed, errorCode: "evidence-entity-unbound" }), HASH)).toBe(true);
	});

	it("v3, v4 and v5 jobs for one run have different singleton keys", () => {
		expect(sentimentSingletonKey(RUN, "sent-classifier-v3")).not.toBe(sentimentSingletonKey(RUN, "sent-classifier-v4"));
		expect(sentimentSingletonKey(RUN, "sent-classifier-v4")).not.toBe(sentimentSingletonKey(RUN, "sent-classifier-v5"));
		expect(sentimentSingletonKey(RUN, SENTIMENT_CLASSIFIER_VERSION)).toBe(`sentiment:${RUN}:sent-classifier-v5`);
	});

	it("a v3 payload is skipped by the v4 worker without loading, claiming or calling", async () => {
		const loadRun = vi.fn();
		const outcome = await runSentimentJob(
			{ promptRunId: RUN, classifierVersion: "sent-classifier-v3", taxonomyVersion: SENTIMENT_TAXONOMY_VERSION },
			{ loadRun },
		);
		expect(outcome).toEqual({ status: "skipped", reason: 'stale classifier version "sent-classifier-v3"' });
		expect(loadRun).not.toHaveBeenCalled();
	});
});
