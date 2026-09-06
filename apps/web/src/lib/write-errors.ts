import { useCallback } from "react";
import { useDeploymentFeatures } from "@/hooks/use-deployment-features";
import { isPublicError, isWriteDenied } from "@/lib/public-errors";
import { READ_ONLY_ERROR, READ_ONLY_MESSAGE, READ_ONLY_REFUSED } from "@/lib/read-only-errors";

function isReadOnlyRefusal(message: string): boolean {
	return message.includes(READ_ONLY_MESSAGE) || message.includes(READ_ONLY_ERROR);
}

/**
 * The message a failed write shows the user.
 *
 * Only messages written for the user are shown: the read-only refusal, a
 * `PublicError`, or an entitlement denial. Any other error — a database
 * failure, a driver error, a string, nothing at all — gets `fallback`, however
 * readable its own message looks, because its text is not ours to show.
 */
export function writeErrorMessage(error: unknown, fallback: string, readOnly: boolean): string {
	const message = error instanceof Error ? error.message : "";
	if (isReadOnlyRefusal(message)) return READ_ONLY_REFUSED;
	if ((isPublicError(error) || isWriteDenied(error)) && message) return message;
	return readOnly ? READ_ONLY_REFUSED : fallback;
}

export function useWriteErrorMessage(): (error: unknown, fallback: string) => string {
	const readOnly = useDeploymentFeatures()?.readOnly ?? false;

	return useCallback((error: unknown, fallback: string) => writeErrorMessage(error, fallback, readOnly), [readOnly]);
}
