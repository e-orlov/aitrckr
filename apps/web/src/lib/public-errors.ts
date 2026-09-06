import { createSerializationAdapter } from "@tanstack/react-router";

/**
 * The one kind of server error whose message is written for the person at the
 * screen. Everything else a server function throws is an internal failure, and
 * the UI shows a fixed message for it instead of the error's own text: a
 * database error's message carries the SQL and the parameters, which for a
 * prompt save is the prompt text and tags.
 *
 * Start serializes a thrown error as its message alone, so the envelope cannot
 * ride on error properties; the serialization adapters below carry `code` and
 * `message` across and rebuild a `PublicError` in the browser. Nothing else
 * (stack, cause, driver fields) leaves the server.
 */
export class PublicError extends Error {
	readonly publicError = true as const;
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PublicError";
		this.code = code;
		delete this.stack;
	}
}

export const PROMPT_SAVE_FAILED = "Failed to save prompts. Your changes were not saved. Please try again.";

/** True for a `PublicError`, including one rebuilt from a server response. */
export function isPublicError(error: unknown): error is PublicError {
	return (
		error instanceof Error &&
		(error as { publicError?: unknown }).publicError === true &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

/** True for an entitlement denial; its messages are authored for the user. */
export function isWriteDenied(error: unknown): error is Error & { code: string } {
	return (
		error instanceof Error &&
		error.name === "WriteDeniedError" &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

type PublicErrorWire = { code: string; message: string };

export const publicErrorSerializationAdapter = createSerializationAdapter({
	key: "elmo:public-error",
	test: (value): value is PublicError => isPublicError(value),
	toSerializable: (error): PublicErrorWire => ({ code: error.code, message: error.message }),
	fromSerializable: ({ code, message }) => new PublicError(code, message),
});

/**
 * Entitlement denials come from `@workspace/lib` as `WriteDeniedError`; they
 * reach the browser as a `PublicError` so the mapper treats them the same way.
 */
export const writeDeniedSerializationAdapter = createSerializationAdapter({
	key: "elmo:write-denied",
	test: (value): value is Error & { code: string } => isWriteDenied(value),
	toSerializable: (error): PublicErrorWire => ({ code: error.code, message: error.message }),
	fromSerializable: ({ code, message }) => new PublicError(code, message),
});
