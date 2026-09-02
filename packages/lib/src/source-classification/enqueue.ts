import { type CitationLike, collectSourceClassificationCandidates } from "./eligibility";
import { filterHostnamesNeedingClassification } from "./store";
import {
	SOURCE_CLASSIFICATION_QUEUE,
	type SourceClassificationJobData,
	sourceClassificationSingletonKey,
} from "./types";

/** The single pg-boss capability the producer needs (kept narrow for tests). */
export interface SourceClassificationSender {
	send(queue: string, data: SourceClassificationJobData, options: { singletonKey: string }): Promise<string | null>;
}

export interface EnqueueSourceClassificationsDeps {
	filterNeeded?: typeof filterHostnamesNeedingClassification;
}

/**
 * Best-effort producer: turn a freshly persisted citation set into at most one
 * queued classification job per unique eligible hostname + classifier version.
 * Eligibility (normalize → brand/competitor → deterministic domain-level
 * "other") happens in collectSourceClassificationCandidates; the current-
 * version cache filters out already-classified hostnames; the singleton key
 * suppresses duplicate active jobs across racing producers.
 *
 * NEVER throws — a cache-read or queue-send outage must not fail the prompt
 * run that produced the citations. Failures are logged and the hostnames are
 * simply picked up by a later ingest or backfill.
 */
export async function enqueueSourceClassificationsBestEffort(args: {
	citations: CitationLike[];
	brandDomains: Set<string>;
	competitorDomains: Set<string>;
	sender: SourceClassificationSender;
	deps?: EnqueueSourceClassificationsDeps;
}): Promise<{ enqueued: number }> {
	try {
		if (args.citations.length === 0) return { enqueued: 0 };

		const candidates = collectSourceClassificationCandidates(args.citations, args.brandDomains, args.competitorDomains);
		if (candidates.length === 0) return { enqueued: 0 };

		const filterNeeded = args.deps?.filterNeeded ?? filterHostnamesNeedingClassification;
		const needed = new Set(await filterNeeded(candidates.map((candidate) => candidate.hostname)));

		let enqueued = 0;
		for (const candidate of candidates) {
			if (!needed.has(candidate.hostname)) continue;
			await args.sender.send(SOURCE_CLASSIFICATION_QUEUE, candidate, {
				singletonKey: sourceClassificationSingletonKey(candidate.hostname, candidate.classifierVersion),
			});
			enqueued++;
		}
		return { enqueued };
	} catch (error) {
		console.error("Failed to enqueue source-classification jobs (prompt run unaffected):", error);
		return { enqueued: 0 };
	}
}
