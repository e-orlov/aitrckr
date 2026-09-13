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
	/** Stable internal code: a validation code, `provider`, `aborted`, `provider-unconfigured`, `claim-lost` or `unknown`. */
	code: string;
	/** Which class of failure produced it (for diagnosis without payloads). */
	kind: "validation" | "provider" | "aborted" | "configuration" | "claim" | "unknown";
	provider: string;
	model: string;
	/** HTTP status the provider answered with, when the error carried one. */
	httpStatus: number | null;
	/** Constructor name of the original error — a class name, never its message. */
	errorName: string;
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
 * collapses to its class name.
 */
export function sanitizeSentimentError(error: unknown): SafeSentimentError {
	const base = { provider: SENTIMENT_PROVIDER_ID, model: SENTIMENT_MODEL, errorName: nameOf(error) };
	if (error instanceof ClaimLostError) return { ...base, code: "claim-lost", kind: "claim", httpStatus: null };
	if (error instanceof Error && error.name === "SentimentValidationError" && "code" in error) {
		return { ...base, code: String((error as { code: unknown }).code), kind: "validation", httpStatus: null };
	}
	if (error instanceof Error && error.name === "SentimentProviderError") {
		return { ...base, code: "provider-unconfigured", kind: "configuration", httpStatus: null };
	}
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return { ...base, code: "aborted", kind: "aborted", httpStatus: null };
	}
	if (error instanceof Error) {
		return { ...base, code: "provider", kind: "provider", httpStatus: statusOf(error.message) };
	}
	return { ...base, code: "unknown", kind: "unknown", httpStatus: null };
}

/** The stored/logged form: code, provider, model and status only. */
export function safeErrorMessage(safe: SafeSentimentError): string {
	const status = safe.httpStatus === null ? "" : ` HTTP ${safe.httpStatus}`;
	return `${safe.kind} ${safe.code} (${safe.errorName}) via ${safe.provider}/${safe.model}${status}`;
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

	constructor(safe: SafeSentimentError) {
		super(safeErrorMessage(safe));
		this.name = "SentimentJobError";
		this.code = safe.code;
		this.kind = safe.kind;
		this.provider = safe.provider;
		this.model = safe.model;
		this.httpStatus = safe.httpStatus;
		this.errorName = safe.errorName;
	}
}
