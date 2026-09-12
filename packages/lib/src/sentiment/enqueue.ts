import { type DetectableEntity, detectEntityMentions } from "./detector";
import { ensureAnalysis, persistMentions } from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentJobData,
	sentimentSingletonKey,
} from "./types";

/**
 * The single pg-boss capability the producer needs. `send` resolves to the job
 * id, or null when the exclusive queue deduplicated the send against an
 * existing queued/active job with the same singleton key.
 */
export interface SentimentSender {
	send(queue: string, data: SentimentJobData, options: { singletonKey: string }): Promise<string | null>;
}

export type SentimentEnqueueOutcome =
	| { status: "accepted"; jobId: string; mentions: number }
	| { status: "deduplicated"; mentions: number }
	| { status: "no-mentions" }
	| { status: "no-answer" }
	| { status: "failed"; error: string };

/**
 * Supplemental sentiment work for a freshly persisted run: deterministic
 * mention rows first (no provider call), then at most one queued
 * classification job when at least one entity was found. Runs only after the
 * prompt run is durable and NEVER throws — a failure here is logged and left
 * for the repair/backfill scan; it must not turn a successful monitoring
 * response into a failed run.
 */
export async function enqueueSentimentBestEffort(args: {
	promptRunId: string;
	brandId: string;
	answerBody: string | null;
	entities: DetectableEntity[];
	sender: SentimentSender;
}): Promise<SentimentEnqueueOutcome> {
	try {
		if (args.answerBody === null) return { status: "no-answer" };
		const detected = detectEntityMentions(args.answerBody, args.entities);
		await persistMentions({ promptRunId: args.promptRunId, brandId: args.brandId, mentions: detected });
		if (detected.length === 0) return { status: "no-mentions" };
		await ensureAnalysis({ promptRunId: args.promptRunId, brandId: args.brandId });
		const jobId = await sendSentimentJob(args.sender, args.promptRunId);
		return jobId === null
			? { status: "deduplicated", mentions: detected.length }
			: { status: "accepted", jobId, mentions: detected.length };
	} catch (error) {
		console.error(`Failed to enqueue sentiment for run ${args.promptRunId} (prompt run unaffected):`, error);
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/** One send with the current versions and the singleton key; null = deduplicated. */
export function sendSentimentJob(sender: SentimentSender, promptRunId: string): Promise<string | null> {
	const data: SentimentJobData = {
		promptRunId,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	};
	return sender.send(SENTIMENT_QUEUE, data, {
		singletonKey: sentimentSingletonKey(promptRunId, SENTIMENT_CLASSIFIER_VERSION),
	});
}
