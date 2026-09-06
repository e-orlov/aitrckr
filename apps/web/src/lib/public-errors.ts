/**
 * The one kind of server error whose message is written for the person at the
 * screen. Everything else a server function throws is an internal failure, and
 * the UI shows a fixed message for it instead of the error's own text: a
 * database error's message carries the SQL and the parameters, which for a
 * prompt save is the prompt text and tags.
 *
 * Server functions travel to the browser as serialized errors that keep their
 * own enumerable properties, so `publicError` and `code` survive the trip and
 * let the client recognize the envelope. The stack is dropped before the error
 * leaves the server: it names server paths and adds nothing for the user.
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

/** True for a `PublicError`, including one deserialized from a server response. */
export function isPublicError(error: unknown): error is Error & { publicError: true; code: string } {
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
