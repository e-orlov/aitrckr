import * as Sentry from "@sentry/node";
import type { Job } from "pg-boss";

export type ErrorReporter = (queueName: string, error: unknown) => void;

const reportToSentry: ErrorReporter = (queueName, error) => {
	Sentry.withScope((scope) => {
		scope.setTag("queue", queueName);
		Sentry.captureException(error);
	});
};

/**
 * Wraps a pg-boss handler to report errors before re-throwing. Preserves the
 * handler's return value (stored by pg-boss as the job output). Exactly the
 * thrown object is reported, so a handler that throws a sanitized error keeps
 * payloads and credentials out of the capture as well as out of the retry.
 */
export function withSentry<T, R>(
	queueName: string,
	handler: (jobs: Job<T>[]) => Promise<R>,
	report: ErrorReporter = reportToSentry,
): (jobs: Job<T>[]) => Promise<R> {
	return async (jobs) => {
		try {
			return await handler(jobs);
		} catch (error) {
			report(queueName, error);
			throw error;
		}
	};
}
