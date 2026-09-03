import { classifySourceHostname, type SourceClassifierDeps } from "./classifier";
import { getCurrentSourceClassifications, upsertSourceClassification } from "./store";
import {
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassification,
	type SourceClassificationJobData,
	sourceClassificationJobSchema,
} from "./types";

export type SourceClassificationJobOutcome =
	| { status: "classified"; classification: SourceClassification }
	| { status: "cached" }
	| { status: "skipped"; reason: string };

export interface SourceClassificationJobDeps extends SourceClassifierDeps {
	getCurrent?: typeof getCurrentSourceClassifications;
	persist?: typeof upsertSourceClassification;
	classify?: typeof classifySourceHostname;
}

/**
 * Worker-side core for one classify-source-domain job. Duplicate/racing jobs
 * are safe: the current cache is re-checked here, after the singleton-key
 * dedupe at enqueue, so a hostname classified while this job waited makes no
 * provider call. Invalid payloads and stale-version payloads are skipped
 * without a provider call and without failing the job; provider/validation
 * errors propagate so pg-boss applies its bounded retry policy, and no row is
 * written for them.
 */
export async function runSourceClassificationJob(
	data: unknown,
	deps: SourceClassificationJobDeps = {},
): Promise<SourceClassificationJobOutcome> {
	const parsed = sourceClassificationJobSchema.safeParse(data);
	if (!parsed.success) {
		return { status: "skipped", reason: `invalid payload: ${parsed.error.issues[0]?.message ?? "unknown"}` };
	}
	const payload: SourceClassificationJobData = parsed.data;

	if (payload.classifierVersion !== SOURCE_CLASSIFIER_VERSION) {
		return { status: "skipped", reason: `stale classifier version "${payload.classifierVersion}"` };
	}

	const getCurrent = deps.getCurrent ?? getCurrentSourceClassifications;
	const cached = await getCurrent([payload.hostname]);
	if (cached.has(payload.hostname)) return { status: "cached" };

	const classify = deps.classify ?? classifySourceHostname;
	const classification = await classify(payload, deps);

	const persist = deps.persist ?? upsertSourceClassification;
	await persist(classification);

	return { status: "classified", classification };
}
