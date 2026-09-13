/**
 * A locally detected defect in a classifier answer (schema, identity,
 * consistency, evidence). `code` is a fixed identifier that may be stored and
 * logged; the message may quote the answer and never leaves the process.
 */
export class SentimentValidationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SentimentValidationError";
	}
}
