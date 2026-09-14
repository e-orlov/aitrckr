import { type SentimentDiagnostic, sentimentDiagnosticSchema, serializeDiagnostic } from "./diagnostics";
import type { PaidResponseEnvelope } from "./errors-validation";
import { SENTIMENT_MODEL, SENTIMENT_PROVIDER_ID } from "./types";

/** A claimant's fenced write found the analysis owned by a later attempt. */
export class ClaimLostError extends Error {
	constructor(readonly claim: { analysisId: string; generation: number }) {
		super(`analysis ${claim.analysisId} is no longer owned by claim generation ${claim.generation}`);
		this.name = "ClaimLostError";
	}
}

/**
 * Stable, allowlisted description of a failed attempt: what may be stored,
 * logged and captured. Never carries the original message, a request or
 * response body, an answer excerpt or a credential.
 */
export interface SafeSentimentError {
	/** Stable internal code: a validation code, `provider`, `aborted`, `provider-unconfigured`, `claim-lost`, `persistence`, `canary-contract`, `canary-input-drift` or `unknown`. */
	code: string;
	/** Which class of failure produced it (for diagnosis without payloads). */
	kind: "validation" | "provider" | "aborted" | "configuration" | "claim" | "store" | "contract" | "unknown";
	provider: string;
	model: string;
	/** HTTP status the provider answered with, when the error carried one. */
	httpStatus: number | null;
	/** Constructor name of the original error — a class name, never its message. */
	errorName: string;
	/** False when the attempt was refused before any request left; such an attempt is not attributed as provider usage. */
	requestSent: boolean;
	/** The paid response's generation id, request summary and numeric usage when the failure came after the provider had answered. */
	envelope: PaidResponseEnvelope | null;
	/** Bounded, allowlisted detail of a locally rejected answer; null for every other failure. */
	diagnostic: SentimentDiagnostic | null;
}

const HTTP_STATUS = /\((\d{3})\)/;

function statusOf(message: string): number | null {
	const match = HTTP_STATUS.exec(message);
	if (!match) return null;
	const status = Number(match[1]);
	return status >= 100 && status <= 599 ? status : null;
}

function nameOf(error: unknown): string {
	if (error instanceof Error) return error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60) || "Error";
	return typeof error;
}

/**
 * Reduce any thrown value to its safe summary. Validation errors keep their
 * code (the codes are fixed identifiers, never excerpt text); provider errors
 * keep only the HTTP status parsed out of the message; everything else
 * collapses to its class name. `stage` says where the attempt failed: an
 * unclassified error at the provider boundary is a provider failure, the
 * same error while writing the result is a persistence failure — the two
 * must never be confused, because only the second one happened after a paid
 * call succeeded.
 */
export function sanitizeSentimentError(error: unknown, stage: "provider" | "persist" = "provider"): SafeSentimentError {
	const base = {
		provider: SENTIMENT_PROVIDER_ID,
		model: SENTIMENT_MODEL,
		errorName: nameOf(error),
		requestSent: true,
		envelope: null,
		diagnostic: null,
	};
	if (error instanceof Error && error.name === "SentimentCanaryInputDriftError") {
		return { ...base, code: "canary-input-drift", kind: "contract", httpStatus: null, requestSent: false };
	}
	if (error instanceof ClaimLostError) return { ...base, code: "claim-lost", kind: "claim", httpStatus: null };
	if (error instanceof Error && error.name === "SentimentValidationError" && "code" in error) {
		const v = error as { code: unknown; requestSent?: unknown; envelope?: unknown; diagnostic?: unknown };
		return {
			...base,
			code: String(v.code),
			kind: "validation",
			httpStatus: null,
			requestSent: v.requestSent !== false,
			envelope: safeEnvelope(v.envelope),
			diagnostic: safeDiagnostic(v.diagnostic),
		};
	}
	if (error instanceof Error && error.name === "SentimentProviderError") {
		return { ...base, code: "provider-unconfigured", kind: "configuration", httpStatus: null };
	}
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return { ...base, code: "aborted", kind: "aborted", httpStatus: null };
	}
	if (error instanceof Error && error.name === "SentimentCanaryContractError") {
		return { ...base, code: "canary-contract", kind: "contract", httpStatus: null };
	}
	if (stage === "persist") return { ...base, code: "persistence", kind: "store", httpStatus: null };
	if (error instanceof Error) {
		return { ...base, code: "provider", kind: "provider", httpStatus: statusOf(error.message) };
	}
	return { ...base, code: "unknown", kind: "unknown", httpStatus: null };
}

const GENERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A count: a finite, non-negative safe integer; anything else — including a numeric string — is not reported. */
const countOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** An amount: a finite, non-negative number. */
const amountOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/**
 * The strict allowlist of what a paid response's envelope may leave behind.
 * No input string is ever copied: the model is kept only when it is exactly
 * the locked sentiment model (otherwise the whole request summary is
 * dropped), the generation id only when it is an opaque identifier, counts
 * only as safe non-negative integers, the cost only as a finite non-negative
 * number, flags only as booleans. Unknown fields are ignored.
 */
function safeEnvelope(value: unknown): PaidResponseEnvelope | null {
	const e = record(value);
	if (!e) return null;
	const r = record(e.request);
	const u = record(e.usage);
	return {
		generationId: typeof e.generationId === "string" && GENERATION_ID.test(e.generationId) ? e.generationId : null,
		request:
			r && r.model === SENTIMENT_MODEL
				? {
						model: SENTIMENT_MODEL,
						webSearch: r.webSearch === true,
						maxToolCalls: countOrNull(r.maxToolCalls),
						maxOutputTokens: countOrNull(r.maxOutputTokens),
					}
				: null,
		usage: u
			? {
					inputTokens: countOrNull(u.inputTokens),
					outputTokens: countOrNull(u.outputTokens),
					reasoningTokens: countOrNull(u.reasoningTokens),
					costUsd: amountOrNull(u.costUsd),
					webSearchRequests: countOrNull(u.webSearchRequests),
					webSearchRequestsConflict: u.webSearchRequestsConflict === true,
				}
			: null,
	};
}

function safeDiagnostic(value: unknown): SentimentDiagnostic | null {
	const parsed = sentimentDiagnosticSchema.safeParse(value);
	return parsed.success && serializeDiagnostic(parsed.data) !== null ? parsed.data : null;
}

/** The stored/logged form: code, provider, model and status only. */
export function safeErrorMessage(safe: SafeSentimentError): string {
	const status = safe.httpStatus === null ? "" : ` HTTP ${safe.httpStatus}`;
	return `${safe.kind} ${safe.code} (${safe.errorName}) via ${safe.provider}/${safe.model}${status}`;
}

/** What the analysis row keeps: the safe message, followed by the bounded diagnostic when there is one. */
export function storedErrorMessage(safe: SafeSentimentError): string {
	const diagnostic = safe.diagnostic ? serializeDiagnostic(safe.diagnostic) : null;
	return diagnostic ? `${safeErrorMessage(safe)} diagnostic=${diagnostic}` : safeErrorMessage(safe);
}

/**
 * What the job throws so pg-boss retries and Sentry captures: the safe
 * summary as the message, structured safe fields as own properties, and no
 * `cause` — the original error (which may quote a response body, an answer
 * or an authorization header) is dropped at this boundary.
 */
export class SentimentJobError extends Error {
	readonly code: string;
	readonly kind: SafeSentimentError["kind"];
	readonly provider: string;
	readonly model: string;
	readonly httpStatus: number | null;
	readonly errorName: string;
	readonly envelope: PaidResponseEnvelope | null;
	readonly diagnostic: SentimentDiagnostic | null;

	constructor(safe: SafeSentimentError) {
		super(safeErrorMessage(safe));
		this.name = "SentimentJobError";
		this.code = safe.code;
		this.kind = safe.kind;
		this.provider = safe.provider;
		this.model = safe.model;
		this.httpStatus = safe.httpStatus;
		this.errorName = safe.errorName;
		this.envelope = safe.envelope;
		this.diagnostic = safe.diagnostic;
	}
}
