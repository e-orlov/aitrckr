import type { StructuredResearchUsage } from "../providers/types";
import { runSentimentJob, type SentimentJobDeps, type SentimentJobOutcome } from "./job";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION } from "./types";

/** Provider request deadline for the canary: the fetch is aborted after this. */
export const SENTIMENT_CANARY_DEADLINE_MS = 120_000;
/** Outer watchdog: the whole invocation fails no later than this, whatever the provider does. */
export const SENTIMENT_CANARY_WATCHDOG_MS = 130_000;

export class SentimentCanaryError extends Error {
	constructor(
		readonly code: "invalid-run-id" | "not-frozen-run" | "watchdog",
		message: string,
	) {
		super(message);
		this.name = "SentimentCanaryError";
	}
}

export interface SentimentCanaryReport {
	runId: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	/** `runSentimentJob` invocations made by this canary — always exactly 1 when the run id was accepted. */
	attempts: 1;
	outcome:
		| { status: SentimentJobOutcome["status"]; entities?: number; usage?: StructuredResearchUsage }
		| { status: "error"; name: string; code: string | null; httpStatus: number | null };
	deadlineMs: number;
	watchdogMs: number;
	classifierVersion: string;
	taxonomyVersion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept exactly one run id and only the frozen one. Anything else — a
 * second id, a list, whitespace-joined ids, a different id — is refused
 * before any work starts.
 */
export function acceptCanaryRunId(argv: readonly string[], frozenRunId: string): string {
	if (argv.length !== 1) {
		throw new SentimentCanaryError("invalid-run-id", `expected exactly one run id argument, got ${argv.length}`);
	}
	const candidate = argv[0].trim();
	if (!UUID.test(candidate)) throw new SentimentCanaryError("invalid-run-id", "run id must be a single uuid");
	if (candidate.toLowerCase() !== frozenRunId.toLowerCase()) {
		throw new SentimentCanaryError("not-frozen-run", "run id is not the frozen canary run");
	}
	return candidate.toLowerCase();
}

/**
 * The one-shot paid canary: invoke the production job core exactly once for
 * the frozen run, with the provider request under `AbortSignal.timeout` and
 * the whole invocation under an outer watchdog. Nothing is enqueued, nothing
 * is retried — a failure ends here with a safe report; a further attempt
 * needs a new explicit authorization and invocation. Uses the same
 * classification and persistence path as the worker (`runSentimentJob`), so
 * what it writes is exactly what the queue path would write.
 */
export async function runSentimentCanary(args: {
	runId: string;
	deps?: SentimentJobDeps;
	deadlineMs?: number;
	watchdogMs?: number;
	job?: typeof runSentimentJob;
}): Promise<SentimentCanaryReport> {
	const deadlineMs = args.deadlineMs ?? SENTIMENT_CANARY_DEADLINE_MS;
	const watchdogMs = args.watchdogMs ?? SENTIMENT_CANARY_WATCHDOG_MS;
	if (watchdogMs <= deadlineMs)
		throw new SentimentCanaryError("watchdog", "watchdog must outlast the request deadline");
	const startedAt = new Date();
	const payload = {
		promptRunId: args.runId,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	};
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const bark = new Promise<never>((_resolve, reject) => {
		watchdog = setTimeout(
			() => reject(new SentimentCanaryError("watchdog", `canary exceeded ${watchdogMs} ms`)),
			watchdogMs,
		);
	});
	let outcome: SentimentCanaryReport["outcome"];
	try {
		const result = await Promise.race([
			(args.job ?? runSentimentJob)(payload, args.deps ?? {}, { signal: AbortSignal.timeout(deadlineMs) }),
			bark,
		]);
		outcome =
			result.status === "classified"
				? { status: result.status, entities: result.entities, usage: result.usage }
				: { status: result.status };
	} catch (error) {
		const e = error as { name?: string; code?: unknown; httpStatus?: unknown };
		outcome = {
			status: "error",
			name: typeof e?.name === "string" ? e.name : "Error",
			code: typeof e?.code === "string" ? e.code : null,
			httpStatus: typeof e?.httpStatus === "number" ? e.httpStatus : null,
		};
	} finally {
		if (watchdog) clearTimeout(watchdog);
	}
	const finishedAt = new Date();
	return {
		runId: args.runId,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		attempts: 1,
		outcome,
		deadlineMs,
		watchdogMs,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	};
}
