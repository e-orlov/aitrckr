import { PROMPT_JOB_OPTIONS } from "./reschedule";

/** The pg-boss capabilities queue convergence needs (kept narrow for tests). */
export interface PromptQueueAdmin {
	createQueue(name: string, options?: object): Promise<void>;
	updateQueue(name: string, options?: object): Promise<void>;
}

/**
 * Idempotently converge the process-prompt queue onto the canonical policy.
 * `createQueue` alone is not enough: it does not change the options of a queue
 * that already exists, so a production queue created with older defaults would
 * keep handing them to jobs that don't override every field. `updateQueue` is
 * the supported way to change options in place — it never touches existing
 * jobs. Safe to run from web and worker concurrently: both converge to the
 * same values.
 */
export async function ensurePromptQueue(boss: PromptQueueAdmin): Promise<void> {
	await boss.createQueue("process-prompt", PROMPT_JOB_OPTIONS);
	await boss.updateQueue("process-prompt", PROMPT_JOB_OPTIONS);
}
