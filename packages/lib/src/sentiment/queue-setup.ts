import { SENTIMENT_QUEUE } from "./types";

/**
 * Exclusive policy is what makes the singleton-key dedupe real (one queued or
 * active classification per run and classifier version). Expiry is longer
 * than one structured call with web search but bounded; retries are few, with
 * backoff, so a provider outage cannot fan out into an unbounded paid retry
 * storm.
 */
export const SENTIMENT_QUEUE_OPTIONS = {
	policy: "exclusive",
	retryLimit: 3,
	retryDelay: 60,
	retryBackoff: true,
	expireInSeconds: 60 * 15,
} as const;

export interface SentimentQueueAdmin {
	createQueue(name: string, options?: object): Promise<void>;
	getQueue(name: string): Promise<{ policy?: string | null } | null>;
}

/**
 * Idempotently create the queue and verify its EFFECTIVE policy; pg-boss queue
 * policy is immutable, so a mismatch fails fast instead of silently running
 * without deduplication.
 */
export async function ensureSentimentQueue(boss: SentimentQueueAdmin): Promise<void> {
	await boss.createQueue(SENTIMENT_QUEUE, SENTIMENT_QUEUE_OPTIONS);
	const queue = await boss.getQueue(SENTIMENT_QUEUE);
	if (!queue) throw new Error(`pg-boss queue "${SENTIMENT_QUEUE}" is missing after createQueue`);
	if (queue.policy !== SENTIMENT_QUEUE_OPTIONS.policy) {
		throw new Error(
			`pg-boss queue "${SENTIMENT_QUEUE}" has policy "${queue.policy ?? "standard"}", but sentiment singleton-key ` +
				`deduplication requires "${SENTIMENT_QUEUE_OPTIONS.policy}". Queue policy is immutable — an operator must drain ` +
				`and recreate the queue in a maintenance window; refusing to modify or delete it automatically.`,
		);
	}
}
