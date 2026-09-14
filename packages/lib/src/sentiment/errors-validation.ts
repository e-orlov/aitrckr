import type { StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import type { SentimentDiagnostic } from "./diagnostics";

/**
 * What survives of a paid provider response when its content is rejected:
 * the opaque generation id, the request shape and the numeric usage. Never
 * the completion, the prompt or the answer.
 */
export interface PaidResponseEnvelope {
	generationId: string | null;
	request: StructuredResearchRequestSummary | null;
	usage: StructuredResearchUsage | null;
}

/**
 * A locally detected defect in a classifier answer (schema, identity,
 * consistency, evidence). `code` is a fixed identifier that may be stored and
 * logged; the message may quote the answer and never leaves the process.
 * `diagnostic` is the bounded, allowlisted detail that may. `envelope` is
 * present when the defect was found after the provider had answered (and
 * charged); `requestSent` is false for refusals raised before any request.
 */
export class SentimentValidationError extends Error {
	envelope: PaidResponseEnvelope | null = null;
	requestSent = true;

	constructor(
		readonly code: string,
		message: string,
		readonly diagnostic: SentimentDiagnostic | null = null,
	) {
		super(message);
		this.name = "SentimentValidationError";
	}

	/** Mark as raised before any provider request left (no usage to attribute). */
	beforeRequest(): this {
		this.requestSent = false;
		return this;
	}

	withEnvelope(envelope: PaidResponseEnvelope): this {
		this.envelope = envelope;
		if (this.diagnostic && envelope.generationId) this.diagnostic.generationId = envelope.generationId;
		return this;
	}
}
