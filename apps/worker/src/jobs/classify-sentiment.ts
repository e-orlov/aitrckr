import { runSentimentJob, type SentimentJobData } from "@workspace/lib/sentiment";
import type { Job } from "pg-boss";

/**
 * Sentiment classification for one stored prompt run. All semantics (payload
 * validation, analysis-state re-check, deterministic mention repair, one
 * provider call, atomic persistence, usage attribution) live in
 * runSentimentJob; a thrown error (already reduced to a safe summary) propagates
 * so pg-boss applies the queue's bounded retry policy without ever writing a
 * partial observation. An answer the classifier rejected is a completed job:
 * the analysis is failed for exactly that input and retrying could only buy
 * the same answer again. The job's abort signal reaches the provider request.
 * Logs carry ids, states, codes and the bounded diagnostic only — never
 * answer text.
 */
export async function classifySentimentJob(jobs: Job<SentimentJobData>[]): Promise<void> {
	for (const job of jobs) {
		const runId = job.data?.promptRunId;
		const outcome = await runSentimentJob(job.data, {}, { signal: job.signal });
		switch (outcome.status) {
			case "classified":
				console.log(
					`[classify-sentiment] run ${runId}: classified ${outcome.entities} entit${outcome.entities === 1 ? "y" : "ies"}`,
				);
				break;
			case "already-completed":
				console.log(`[classify-sentiment] run ${runId}: current analysis already completed, skipping`);
				break;
			case "claimed-elsewhere":
				console.log(
					`[classify-sentiment] run ${runId}: analysis ${outcome.analysisStatus} under another claim, skipping`,
				);
				break;
			case "claim-lost":
				console.log(
					`[classify-sentiment] run ${runId}: claim generation ${outcome.generation} superseded, nothing written`,
				);
				break;
			case "no-mentions":
				console.log(`[classify-sentiment] run ${runId}: no entity mentions, no provider call`);
				break;
			case "skipped":
				console.log(`[classify-sentiment] run ${runId}: skipped (${outcome.reason})`);
				break;
			case "terminal-validation-failure":
				console.warn(
					`[classify-sentiment] run ${runId}: answer rejected (${outcome.code}), terminal for this input; ` +
						`paid=${outcome.requestSent} generation=${outcome.envelope?.generationId ?? "none"} ` +
						`diagnostic=${outcome.diagnostic ? JSON.stringify(outcome.diagnostic) : "none"}`,
				);
				break;
		}
	}
}
