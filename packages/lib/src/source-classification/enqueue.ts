import { type CitationLike, collectSourceClassificationCandidates } from "./eligibility";
import { filterHostnamesNeedingClassification } from "./store";
import {
	SOURCE_CLASSIFICATION_QUEUE,
	type SourceClassificationJobData,
	sourceClassificationSingletonKey,
} from "./types";

/**
 * The single pg-boss capability the producer needs (kept narrow for tests).
 * `send` resolves to the job id, or null when the exclusive queue policy
 * deduplicated the send against an existing queued/active job with the same
 * singleton key.
 */
export interface SourceClassificationSender {
	send(queue: string, data: SourceClassificationJobData, options: { singletonKey: string }): Promise<string | null>;
}

export interface EnqueueSourceClassificationsDeps {
	filterNeeded?: typeof filterHostnamesNeedingClassification;
}

export interface SourceClassificationEnqueueResult {
	/** Eligible candidates a send was attempted for. */
	attempted: number;
	/** Sends pg-boss actually accepted (non-null job id). */
	accepted: number;
	/** Sends pg-boss deduplicated against an existing job (null id). */
	deduplicated: number;
	/** Sends that threw; the remaining candidates are still attempted. */
	failed: number;
}

/**
 * Best-effort producer: turn a freshly persisted citation set into at most one
 * queued classification job per unique eligible hostname + classifier version.
 * Eligibility (normalize → brand/competitor → deterministic domain-level
 * "other") happens in collectSourceClassificationCandidates; the current-
 * version cache filters out already-classified hostnames; the exclusive queue
 * policy plus singleton key suppress duplicate queued/active jobs across
 * racing producers — such a send resolves to null and is counted as
 * deduplicated, never as accepted.
 *
 * NEVER throws — a cache-read or queue-send outage must not fail the prompt
 * run that produced the citations. A failing send is counted and skipped
 * without discarding sends that already succeeded; the hostnames are simply
 * picked up by a later ingest or backfill.
 */
export async function enqueueSourceClassificationsBestEffort(args: {
	citations: CitationLike[];
	brandDomains: Set<string>;
	competitorDomains: Set<string>;
	sender: SourceClassificationSender;
	deps?: EnqueueSourceClassificationsDeps;
}): Promise<SourceClassificationEnqueueResult> {
	const result: SourceClassificationEnqueueResult = { attempted: 0, accepted: 0, deduplicated: 0, failed: 0 };
	if (args.citations.length === 0) return result;

	let candidates: SourceClassificationJobData[];
	try {
		const all = collectSourceClassificationCandidates(args.citations, args.brandDomains, args.competitorDomains);
		if (all.length === 0) return result;
		const filterNeeded = args.deps?.filterNeeded ?? filterHostnamesNeedingClassification;
		const needed = new Set(await filterNeeded(all.map((candidate) => candidate.hostname)));
		candidates = all.filter((candidate) => needed.has(candidate.hostname));
	} catch (error) {
		console.error("Failed to prepare source-classification jobs (prompt run unaffected):", error);
		return result;
	}

	for (const candidate of candidates) {
		result.attempted++;
		try {
			const jobId = await args.sender.send(SOURCE_CLASSIFICATION_QUEUE, candidate, {
				singletonKey: sourceClassificationSingletonKey(candidate.hostname, candidate.classifierVersion),
			});
			if (jobId === null) result.deduplicated++;
			else result.accepted++;
		} catch (error) {
			result.failed++;
			console.error(
				`Failed to enqueue source classification for "${candidate.hostname}" (prompt run unaffected):`,
				error,
			);
		}
	}
	return result;
}
