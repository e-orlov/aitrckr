import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	Provider,
	StructuredResearchOptions,
	StructuredResearchRequestSummary,
	StructuredResearchUsage,
} from "../providers/types";
import { classifySentiment, SENTIMENT_MAX_OUTPUT_TOKENS, sentimentInputHash } from "./classifier";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import { runSentimentJob, type SentimentJobDeps, type SentimentJobOutcome } from "./job";
import { buildSentimentPrompt } from "./prompt";
import { resolveSentimentProvider } from "./provider";
import {
	candidatesFromMentions,
	loadDetectableEntities,
	loadDetection,
	loadMentions,
	loadRunForSentiment,
	persistClassification,
	type StoredMention,
} from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
	sortSentimentEntities,
} from "./types";

/** Provider request deadline for the canary: the fetch is aborted after this. */
export const SENTIMENT_CANARY_DEADLINE_MS = 120_000;
/** Outer watchdog: the whole invocation fails no later than this, whatever the provider does. */
export const SENTIMENT_CANARY_WATCHDOG_MS = 130_000;

/**
 * Post-call acceptance thresholds. None of them limits spending before the
 * call — the pre-call limiters are `max_tokens` and `max_tool_calls` on the
 * request; these decide whether the one call that happened is accepted.
 */
export const SENTIMENT_CANARY_LIMITS = Object.freeze({
	maxCostUsd: 0.1,
	maxOutputTokens: SENTIMENT_MAX_OUTPUT_TOKENS,
	webSearchRequests: 1,
	maxToolCalls: 1,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything the canary must find exactly as frozen before it may spend, and
 * exactly as expected afterwards. Authored by the operator from
 * `inspectSentimentCanaryRun` and kept outside Git; it carries ids, a digest
 * and versions — never the answer, the prompt or a credential.
 */
export const sentimentCanaryContractSchema = z.strictObject({
	runId: z.string().regex(UUID),
	promptId: z.string().regex(UUID),
	brandId: z.string().min(1),
	/** SHA-256 (hex) of the extracted answer body exactly as the classifier receives it. */
	answerBodySha256: z.string().regex(/^[0-9a-f]{64}$/),
	entities: z.array(z.strictObject({ key: z.string().min(1), entityType: z.enum(["brand", "competitor"]) })).min(1),
	/** `sentimentInputHash` over the body and the exact candidates (keys, types, names, aliases) the job would send. */
	classifierInputHash: z.string().regex(/^[0-9a-f]{64}$/),
	/** SHA-256 (hex) of the exact prompt string the provider would receive, candidate order included. */
	providerPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
	classifierVersion: z.string().min(1),
	taxonomyVersion: z.string().min(1),
	provider: z.string().min(1),
	model: z.string().min(1),
});

export type SentimentCanaryContract = z.infer<typeof sentimentCanaryContractSchema>;
export type SentimentCanaryEntity = SentimentCanaryContract["entities"][number];

/** Stable reasons a canary is refused or rejected. Never carry text from the run, the prompt or the provider. */
export const SENTIMENT_CANARY_REJECT_CODES = [
	"contract-classifier-version",
	"contract-taxonomy-version",
	"contract-provider",
	"contract-model",
	"run-not-found",
	"prompt-mismatch",
	"brand-mismatch",
	"body-unextractable",
	"body-hash-mismatch",
	"entity-unknown",
	"entity-set-mismatch",
	"contract-input-hash",
	"contract-prompt-hash",
	"input-hash-drift",
	"prompt-hash-drift",
	"attempts",
	"provider-calls",
	"job-outcome",
	"watchdog",
	"request-deadline",
	"provider-error",
	"provider-unconfigured",
	"persistence-failed",
	"validation",
	"error",
	"request-unverified",
	"request-model",
	"request-web-search",
	"request-max-tool-calls",
	"request-max-tokens",
	"usage-missing",
	"web-search-count-conflict",
	"web-search-count-unknown",
	"web-search-count",
	"cost-missing",
	"cost-exceeded",
	"output-tokens-missing",
	"output-tokens-exceeded",
	"entities-mismatch",
] as const;

export type SentimentCanaryRejectCode = (typeof SENTIMENT_CANARY_REJECT_CODES)[number];

/** A rejection reason: the stable code plus, where one exists, a stable qualifier (a status or an error code — never text). */
export interface SentimentCanaryReason {
	code: SentimentCanaryRejectCode;
	detail?: string;
}

export type SentimentCanaryVerdict = { status: "accept" } | { status: "reject"; reasons: SentimentCanaryReason[] };

export class SentimentCanaryError extends Error {
	constructor(
		readonly code: "invalid-run-id" | "not-frozen-run" | "watchdog" | "invalid-contract",
		message: string,
	) {
		super(message);
		this.name = "SentimentCanaryError";
	}
}

/**
 * Thrown at the persistence boundary when the provider's answer fails the
 * post-call contract: the job core then attributes the paid call once, marks
 * the analysis failed with the `canary-contract` code and writes nothing else.
 */
export class SentimentCanaryContractError extends Error {
	constructor(readonly reasons: SentimentCanaryReason[]) {
		super(`canary contract rejected: ${reasons.map((reason) => reason.code).join(", ")}`);
		this.name = "SentimentCanaryContractError";
	}
}

export type SentimentCanaryOutcome =
	| {
			status: SentimentJobOutcome["status"];
			entities?: number;
			entityKeys?: string[];
			usage?: StructuredResearchUsage;
			request?: StructuredResearchRequestSummary;
	  }
	| { status: "error"; name: string; code: string | null; httpStatus: number | null };

export interface SentimentCanaryReport {
	runId: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	preflight: { status: "passed" } | { status: "refused"; reasons: SentimentCanaryReason[] };
	/** `runSentimentJob` invocations made by this canary: 0 when refused before the call, otherwise exactly 1. */
	attempts: 0 | 1;
	/** Provider requests observed through the classifier's provider boundary. */
	providerCalls: number;
	outcome: SentimentCanaryOutcome | null;
	verdict: SentimentCanaryVerdict;
	deadlineMs: number;
	watchdogMs: number;
	classifierVersion: string;
	taxonomyVersion: string;
}

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

/** Parse an operator-authored contract; anything unknown or malformed is refused. */
export function parseSentimentCanaryContract(raw: unknown): SentimentCanaryContract {
	const parsed = sentimentCanaryContractSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new SentimentCanaryError(
			"invalid-contract",
			`contract ${issue?.path.join(".") || "root"}: ${issue?.code ?? "invalid"}`,
		);
	}
	return {
		...parsed.data,
		runId: parsed.data.runId.toLowerCase(),
		promptId: parsed.data.promptId.toLowerCase(),
		entities: sortSentimentEntities(parsed.data.entities),
	};
}

/** The digest the contract freezes: SHA-256 of the extracted body, UTF-8. */
export function sentimentCanaryBodyDigest(answerBody: string): string {
	return createHash("sha256").update(answerBody, "utf8").digest("hex");
}

const entityToken = (entity: SentimentCanaryEntity) => `${entity.entityType}:${entity.key}`;

function sameEntitySet(expected: readonly SentimentCanaryEntity[], actual: readonly SentimentCanaryEntity[]): boolean {
	const want = new Set(expected.map(entityToken));
	const have = new Set(actual.map(entityToken));
	return want.size === have.size && [...want].every((token) => have.has(token));
}

/**
 * The entities the job would classify for the run, resolved the way the job
 * resolves them: the current detection receipt when one exists, otherwise a
 * deterministic scan — without writing anything.
 */
async function resolveCanaryInput(
	run: { id: string; answerBody: string },
	roster: DetectableEntity[],
	deps: SentimentJobDeps,
): Promise<{ entities: SentimentCanaryEntity[]; candidates: SentimentCandidate[] }> {
	const receipt = await (deps.loadDetection ?? loadDetection)(run.id);
	const mentions: Omit<StoredMention, "id">[] = receipt
		? receipt.status === "mentions"
			? await (deps.loadMentions ?? loadMentions)(run.id)
			: []
		: detectEntityMentions(run.answerBody, roster);
	return {
		entities: sortSentimentEntities(mentions.map((mention) => ({ key: mention.key, entityType: mention.entityType }))),
		candidates: candidatesFromMentions(
			mentions.map((mention) => ({ id: "", ...mention })),
			roster,
		),
	};
}

/** The two digests that pin the exact classifier input: the canonical hash and the literal outbound prompt. */
export function sentimentCanaryInputDigests(args: { answerBody: string; candidates: SentimentCandidate[] }): {
	classifierInputHash: string;
	providerPromptSha256: string;
} {
	return {
		classifierInputHash: sentimentInputHash(args.answerBody, args.candidates),
		providerPromptSha256: createHash("sha256").update(buildSentimentPrompt(args), "utf8").digest("hex"),
	};
}

export interface SentimentCanaryRunDescription {
	runId: string;
	promptId: string;
	brandId: string;
	answerBodySha256: string | null;
	entities: SentimentCanaryEntity[];
	classifierInputHash: string | null;
	providerPromptSha256: string | null;
	classifierVersion: string;
	taxonomyVersion: string;
	provider: string;
	model: string;
}

/**
 * Read-only description of a stored run in contract form — what an operator
 * freezes before authorizing the call. Contains no answer text.
 */
export async function inspectSentimentCanaryRun(
	runId: string,
	deps: SentimentJobDeps = {},
): Promise<SentimentCanaryRunDescription | null> {
	const run = await (deps.loadRun ?? loadRunForSentiment)(runId);
	if (!run) return null;
	const roster = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const input =
		run.answerBody === null ? null : await resolveCanaryInput({ id: run.id, answerBody: run.answerBody }, roster, deps);
	const digests =
		run.answerBody === null || input === null || input.candidates.length === 0
			? { classifierInputHash: null, providerPromptSha256: null }
			: sentimentCanaryInputDigests({ answerBody: run.answerBody, candidates: input.candidates });
	return {
		runId: run.id,
		promptId: run.promptId,
		brandId: run.brandId,
		answerBodySha256: run.answerBody === null ? null : sentimentCanaryBodyDigest(run.answerBody),
		entities: input?.entities ?? [],
		...digests,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		provider: SENTIMENT_PROVIDER_ID,
		model: SENTIMENT_MODEL,
	};
}

/**
 * Everything that can be checked before the provider is involved: the
 * contract still describes this code, the stored run is the frozen one (ids,
 * body digest) and the job would classify exactly the frozen entity set.
 * Any mismatch refuses the canary; no request leaves.
 */
export async function preflightSentimentCanary(
	contract: SentimentCanaryContract,
	deps: SentimentJobDeps = {},
): Promise<SentimentCanaryReason[]> {
	const reasons: SentimentCanaryReason[] = [];
	if (contract.classifierVersion !== SENTIMENT_CLASSIFIER_VERSION)
		reasons.push({ code: "contract-classifier-version" });
	if (contract.taxonomyVersion !== SENTIMENT_TAXONOMY_VERSION) reasons.push({ code: "contract-taxonomy-version" });
	if (contract.provider !== SENTIMENT_PROVIDER_ID) reasons.push({ code: "contract-provider" });
	if (contract.model !== SENTIMENT_MODEL) reasons.push({ code: "contract-model" });

	const run = await (deps.loadRun ?? loadRunForSentiment)(contract.runId);
	if (!run) return [...reasons, { code: "run-not-found" }];
	if (run.promptId.toLowerCase() !== contract.promptId) reasons.push({ code: "prompt-mismatch" });
	if (run.brandId !== contract.brandId) reasons.push({ code: "brand-mismatch" });
	if (run.answerBody === null) return [...reasons, { code: "body-unextractable" }];
	if (sentimentCanaryBodyDigest(run.answerBody) !== contract.answerBodySha256) {
		reasons.push({ code: "body-hash-mismatch" });
	}

	const roster = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const known = new Set(roster.map((entity) => `${entity.entityType}:${entity.key}`));
	if (!contract.entities.every((entity) => known.has(entityToken(entity)))) reasons.push({ code: "entity-unknown" });
	const actual = await resolveCanaryInput({ id: run.id, answerBody: run.answerBody }, roster, deps);
	if (!sameEntitySet(contract.entities, actual.entities)) reasons.push({ code: "entity-set-mismatch" });
	if (actual.candidates.length > 0) {
		const digests = sentimentCanaryInputDigests({ answerBody: run.answerBody, candidates: actual.candidates });
		if (digests.classifierInputHash !== contract.classifierInputHash) reasons.push({ code: "contract-input-hash" });
		if (digests.providerPromptSha256 !== contract.providerPromptSha256) reasons.push({ code: "contract-prompt-hash" });
	}
	return reasons;
}

/**
 * Thrown at the classifier boundary when the input the job is about to send
 * no longer matches the frozen digests (a name, alias or order changed after
 * preflight). No request has left: the job marks the attempt failed and
 * records no usage.
 */
export class SentimentCanaryInputDriftError extends Error {
	readonly requestSent = false;
	constructor(readonly reasons: SentimentCanaryReason[]) {
		super(`canary input drifted: ${reasons.map((reason) => reason.code).join(", ")}`);
		this.name = "SentimentCanaryInputDriftError";
	}
}

function isValidAmount(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type Limits = typeof SENTIMENT_CANARY_LIMITS;

function requestReasons(
	request: StructuredResearchRequestSummary | undefined,
	contract: SentimentCanaryContract,
	limits: Limits,
): SentimentCanaryReason[] {
	if (!request) return [{ code: "request-unverified" }];
	const reasons: SentimentCanaryReason[] = [];
	if (request.model !== contract.model) reasons.push({ code: "request-model" });
	if (request.webSearch !== true) reasons.push({ code: "request-web-search" });
	if (request.maxToolCalls !== limits.maxToolCalls) reasons.push({ code: "request-max-tool-calls" });
	if (request.maxOutputTokens !== limits.maxOutputTokens) reasons.push({ code: "request-max-tokens" });
	return reasons;
}

function webSearchCountReason(usage: StructuredResearchUsage, limits: Limits): SentimentCanaryReason | null {
	if (usage.webSearchRequestsConflict) return { code: "web-search-count-conflict" };
	if (usage.webSearchRequests === null) return { code: "web-search-count-unknown" };
	if (usage.webSearchRequests !== limits.webSearchRequests) {
		return { code: "web-search-count", detail: String(usage.webSearchRequests) };
	}
	return null;
}

function boundedAmountReason(
	value: number | null,
	max: number,
	codes: { missing: SentimentCanaryRejectCode; exceeded: SentimentCanaryRejectCode },
): SentimentCanaryReason | null {
	if (!isValidAmount(value)) return { code: codes.missing };
	if (value > max) return { code: codes.exceeded };
	return null;
}

function usageReasons(usage: StructuredResearchUsage | undefined, limits: Limits): SentimentCanaryReason[] {
	if (!usage) return [{ code: "usage-missing" }];
	return [
		webSearchCountReason(usage, limits),
		boundedAmountReason(usage.costUsd, limits.maxCostUsd, { missing: "cost-missing", exceeded: "cost-exceeded" }),
		boundedAmountReason(usage.outputTokens, limits.maxOutputTokens, {
			missing: "output-tokens-missing",
			exceeded: "output-tokens-exceeded",
		}),
	].filter((reason): reason is SentimentCanaryReason => reason !== null);
}

function entityKeysMatch(contract: SentimentCanaryContract, entityKeys: string[] | undefined): boolean {
	if (entityKeys === undefined) return false;
	const expected = new Set(contract.entities.map((entity) => entity.key));
	const classified = new Set(entityKeys);
	return (
		classified.size === entityKeys.length &&
		classified.size === expected.size &&
		[...expected].every((key) => classified.has(key))
	);
}

/**
 * The post-call contract: exactly one attempt and one provider request, the
 * request carried the locked model, web search, the tool budget and the
 * output cap, the provider reported usage that fits every threshold, and the
 * classification covers exactly the frozen entities.
 */
export function evaluateSentimentCanary(
	contract: SentimentCanaryContract,
	outcome: SentimentCanaryOutcome | null,
	counts: { attempts: number; providerCalls: number },
	limits: Limits = SENTIMENT_CANARY_LIMITS,
): SentimentCanaryVerdict {
	const reasons: SentimentCanaryReason[] = [];
	if (counts.attempts !== 1) reasons.push({ code: "attempts", detail: String(counts.attempts) });
	if (counts.providerCalls !== 1) reasons.push({ code: "provider-calls", detail: String(counts.providerCalls) });
	if (!outcome) reasons.push({ code: "job-outcome", detail: "none" });
	else if (outcome.status === "error") reasons.push(rejectReasonForError(outcome));
	else if (outcome.status !== "classified") reasons.push({ code: "job-outcome", detail: outcome.status });
	else {
		reasons.push(...requestReasons(outcome.request, contract, limits), ...usageReasons(outcome.usage, limits));
		if (!entityKeysMatch(contract, outcome.entityKeys)) reasons.push({ code: "entities-mismatch" });
	}
	return reasons.length === 0 ? { status: "accept" } : { status: "reject", reasons };
}

function rejectReasonForError(outcome: Extract<SentimentCanaryOutcome, { status: "error" }>): SentimentCanaryReason {
	if (outcome.name === "SentimentCanaryError" && outcome.code === "watchdog") return { code: "watchdog" };
	switch (outcome.code) {
		case "aborted":
			return { code: "request-deadline" };
		case "provider":
			return { code: "provider-error", detail: outcome.httpStatus === null ? undefined : String(outcome.httpStatus) };
		case "provider-unconfigured":
			return { code: "provider-unconfigured" };
		case "persistence":
			return { code: "persistence-failed" };
		case null:
			return { code: "error", detail: outcome.name };
		default:
			return outcome.code === "claim-lost" || outcome.code === "unknown"
				? { code: "error", detail: outcome.code }
				: { code: "validation", detail: outcome.code };
	}
}

function safeOutcomeForError(error: unknown): SentimentCanaryOutcome {
	const e = error as { name?: string; code?: unknown; httpStatus?: unknown };
	return {
		status: "error",
		name: typeof e?.name === "string" ? e.name : "Error",
		code: typeof e?.code === "string" ? e.code : null,
		httpStatus: typeof e?.httpStatus === "number" ? e.httpStatus : null,
	};
}

/**
 * The one-shot paid canary. Preflight first (no request on any mismatch);
 * then exactly one invocation of the production job core for the frozen run
 * with one owned `AbortController`: its signal travels job → classifier →
 * provider fetch, the request deadline aborts it, and the watchdog aborts it
 * again and ends the invocation whatever the provider does. A result that
 * arrives after the abort is still attributed as the paid call it was, but is
 * never written — the persistence step refuses under an aborted signal.
 * Nothing is enqueued and nothing is retried: a further attempt needs a new
 * explicit authorization and a new invocation.
 */
export async function runSentimentCanary(args: {
	contract: SentimentCanaryContract;
	deps?: SentimentJobDeps;
	deadlineMs?: number;
	watchdogMs?: number;
	job?: typeof runSentimentJob;
	limits?: typeof SENTIMENT_CANARY_LIMITS;
}): Promise<SentimentCanaryReport> {
	const deadlineMs = args.deadlineMs ?? SENTIMENT_CANARY_DEADLINE_MS;
	const watchdogMs = args.watchdogMs ?? SENTIMENT_CANARY_WATCHDOG_MS;
	if (watchdogMs <= deadlineMs)
		throw new SentimentCanaryError("watchdog", "watchdog must outlast the request deadline");
	const startedAt = new Date();
	const base: SentimentJobDeps = args.deps ?? {};
	const contract = args.contract;
	const finish = (
		report: Pick<SentimentCanaryReport, "preflight" | "attempts" | "providerCalls" | "outcome" | "verdict">,
	): SentimentCanaryReport => {
		const finishedAt = new Date();
		return {
			runId: contract.runId,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			...report,
			deadlineMs,
			watchdogMs,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		};
	};

	const refused = await preflightSentimentCanary(contract, base);
	if (refused.length > 0) {
		return finish({
			preflight: { status: "refused", reasons: refused },
			attempts: 0,
			providerCalls: 0,
			outcome: null,
			verdict: { status: "reject", reasons: refused },
		});
	}

	const controller = new AbortController();
	let providerCalls = 0;
	let gateReasons: SentimentCanaryReason[] | null = null;
	const classifyBase = base.classify ?? classifySentiment;
	const resolveBase = base.resolveProvider ?? resolveSentimentProvider;
	const deps: SentimentJobDeps = {
		...base,
		resolveProvider: (): Provider => {
			const provider = resolveBase();
			const research = provider.runStructuredResearch?.bind(provider);
			if (!research) return provider;
			return {
				...provider,
				runStructuredResearch<T>(options: StructuredResearchOptions<T>) {
					providerCalls += 1;
					return research(options);
				},
			};
		},
		classify: (classifyArgs, classifyDeps, signal) => {
			// Second look at the exact input, after the job reloaded roster and
			// mentions and immediately before the provider boundary: this is what
			// closes the window between preflight and the call.
			const digests = sentimentCanaryInputDigests(classifyArgs);
			const drift: SentimentCanaryReason[] = [];
			if (digests.classifierInputHash !== contract.classifierInputHash) drift.push({ code: "input-hash-drift" });
			if (digests.providerPromptSha256 !== contract.providerPromptSha256) drift.push({ code: "prompt-hash-drift" });
			if (drift.length > 0) {
				gateReasons = drift;
				return Promise.reject(new SentimentCanaryInputDriftError(drift));
			}
			return classifyBase(classifyArgs, classifyDeps, signal);
		},
		persist: (persistArgs) => {
			if (controller.signal.aborted) {
				return Promise.reject(new DOMException("canary aborted before the write", "AbortError"));
			}
			// The post-call contract is decided here, with the validated answer in
			// hand and before anything is written: a rejected answer never becomes
			// a completed analysis or an observation row.
			const { classification } = persistArgs;
			const gate = evaluateSentimentCanary(
				contract,
				{
					status: "classified",
					entities: classification.entities.length,
					entityKeys: classification.entities.map((entity) => entity.key),
					usage: classification.usage,
					request: classification.request,
				},
				{ attempts: 1, providerCalls },
				args.limits,
			);
			if (gate.status === "reject") {
				gateReasons = gate.reasons;
				return Promise.reject(new SentimentCanaryContractError(gate.reasons));
			}
			return (base.persist ?? persistClassification)(persistArgs);
		},
	};

	const payload = {
		promptRunId: contract.runId,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	};
	const deadline = setTimeout(
		() => controller.abort(new DOMException(`request deadline of ${deadlineMs} ms passed`, "TimeoutError")),
		deadlineMs,
	);
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const bark = new Promise<never>((_resolve, reject) => {
		watchdog = setTimeout(() => {
			controller.abort(new DOMException(`watchdog of ${watchdogMs} ms passed`, "TimeoutError"));
			reject(new SentimentCanaryError("watchdog", `canary exceeded ${watchdogMs} ms`));
		}, watchdogMs);
	});
	let outcome: SentimentCanaryOutcome;
	try {
		const attempt = (args.job ?? runSentimentJob)(payload, deps, { signal: controller.signal });
		// If the watchdog wins the race the attempt is abandoned; its eventual
		// rejection must not surface as an unhandled rejection.
		attempt.catch(() => {});
		const result = await Promise.race([attempt, bark]);
		outcome =
			result.status === "classified"
				? {
						status: result.status,
						entities: result.entities,
						entityKeys: result.entityKeys,
						usage: result.usage,
						request: result.request,
					}
				: { status: result.status };
	} catch (error) {
		outcome = safeOutcomeForError(error);
	} finally {
		clearTimeout(deadline);
		if (watchdog) clearTimeout(watchdog);
	}
	const counts = { attempts: 1 as const, providerCalls };
	return finish({
		preflight: { status: "passed" },
		attempts: 1,
		providerCalls,
		outcome,
		// The gate's own reasons are the verdict when it fired; otherwise the
		// same evaluation over the final outcome is the second, independent check.
		verdict: gateReasons
			? { status: "reject", reasons: gateReasons }
			: evaluateSentimentCanary(contract, outcome, counts, args.limits),
	});
}
