import { runSourceClassificationJob, type SourceClassificationJobData } from "@workspace/lib/source-classification";
import type { Job } from "pg-boss";

/**
 * Supplemental source classification for one hostname whose built-in
 * domain-level category is "other". All semantics (payload validation, cache
 * re-check, non-`other` guard, provider call, atomic upsert) live in
 * runSourceClassificationJob; a thrown error propagates so pg-boss applies the
 * queue's bounded retry policy without ever writing a false cache row.
 */
export async function classifySourceDomainJob(jobs: Job<SourceClassificationJobData>[]): Promise<void> {
	for (const job of jobs) {
		const hostname = job.data?.hostname;
		const outcome = await runSourceClassificationJob(job.data);
		switch (outcome.status) {
			case "classified":
				console.log(
					`[classify-source-domain] ${hostname}: classified as "${outcome.classification.category}" ` +
						`(confidence ${outcome.classification.confidence}, provider ${outcome.classification.provider}, ` +
						`model ${outcome.classification.model ?? "unknown"}, version ${outcome.classification.classifierVersion})`,
				);
				break;
			case "cached":
				console.log(`[classify-source-domain] ${hostname}: current classification already cached, skipping`);
				break;
			case "skipped":
				console.log(`[classify-source-domain] ${hostname}: skipped (${outcome.reason})`);
				break;
		}
	}
}
