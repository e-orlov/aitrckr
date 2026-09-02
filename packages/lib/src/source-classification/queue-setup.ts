import { SOURCE_CLASSIFICATION_QUEUE } from "./types";

/**
 * The F-05 queue must be `exclusive`: pg-boss only enforces "at most one
 * queued-or-active job per singletonKey" under that policy — on the default
 * `standard` policy a singletonKey does not deduplicate, which would allow
 * parallel paid classifications of one hostname.
 */
export const SOURCE_CLASSIFICATION_QUEUE_OPTIONS = {
	policy: "exclusive",
	retryLimit: 3,
	retryDelay: 60,
	retryBackoff: true,
	expireInSeconds: 60 * 10, // one bounded LLM call per job
} as const;

/** The two pg-boss capabilities queue setup needs (kept narrow for tests). */
export interface SourceClassificationQueueAdmin {
	createQueue(name: string, options?: object): Promise<void>;
	getQueue(name: string): Promise<{ policy?: string | null } | null>;
}

/**
 * Idempotently create the F-05 queue and verify its EFFECTIVE policy. A queue's
 * policy is immutable in pg-boss: if the queue already exists with another
 * policy, createQueue cannot change it and dedupe silently would not hold — so
 * this fails fast with instructions instead of deleting/recreating the queue
 * automatically (never safe against a persistent environment).
 */
export async function ensureSourceClassificationQueue(boss: SourceClassificationQueueAdmin): Promise<void> {
	await boss.createQueue(SOURCE_CLASSIFICATION_QUEUE, SOURCE_CLASSIFICATION_QUEUE_OPTIONS);

	const queue = await boss.getQueue(SOURCE_CLASSIFICATION_QUEUE);
	if (!queue) {
		throw new Error(`pg-boss queue "${SOURCE_CLASSIFICATION_QUEUE}" is missing after createQueue`);
	}
	if (queue.policy !== SOURCE_CLASSIFICATION_QUEUE_OPTIONS.policy) {
		throw new Error(
			`pg-boss queue "${SOURCE_CLASSIFICATION_QUEUE}" has policy "${queue.policy ?? "standard"}", but F-05 ` +
				`singleton-key deduplication requires "${SOURCE_CLASSIFICATION_QUEUE_OPTIONS.policy}". Queue policy is ` +
				`immutable — an operator must drain and recreate the queue (pg-boss deleteQueue + createQueue) in a ` +
				`maintenance window; refusing to modify or delete it automatically.`,
		);
	}
}
