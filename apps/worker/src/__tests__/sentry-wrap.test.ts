import assert from "node:assert/strict";
import { test } from "node:test";
import { SentimentJobError, sanitizeSentimentError } from "@workspace/lib/sentiment";
import type { Job } from "pg-boss";
import { withSentry } from "../sentry-wrap";

const LEAKY =
	'OpenRouter API error (429): {"error":"rate limited","answer":"Alpha handles claims fast"} Authorization: Bearer sk-or-should-not-leak-000';

test("the Sentry wrapper captures exactly the sanitized job error and nothing of the original payload", async () => {
	const captured: unknown[] = [];
	const handler = async (_jobs: Job<{ promptRunId: string }>[]) => {
		// What runSentimentJob throws after a provider failure: the safe summary only.
		throw new SentimentJobError(sanitizeSentimentError(new Error(LEAKY)));
	};
	const wrapped = withSentry("classify-sentiment", handler, (_queue, error) => captured.push(error));
	await assert.rejects(wrapped([]), (error: unknown) => {
		assert.equal(captured.length, 1);
		assert.equal(captured[0], error);
		return true;
	});
	const serialized =
		JSON.stringify(captured[0], Object.getOwnPropertyNames(captured[0] as object)) + String(captured[0]);
	for (const forbidden of ["sk-or-", "rate limited", "Authorization", "Alpha handles claims fast"]) {
		assert.doesNotMatch(serialized, new RegExp(forbidden));
	}
	assert.match(serialized, /"code":"provider"/);
	assert.match(serialized, /"httpStatus":429/);
	assert.match(serialized, /"provider":"openrouter"/);
	assert.equal((captured[0] as Error).cause, undefined);
});

test("the wrapper preserves the handler's return value and reports nothing on success", async () => {
	const captured: unknown[] = [];
	const wrapped = withSentry(
		"classify-sentiment",
		async () => "ok",
		(_queue, error) => captured.push(error),
	);
	assert.equal(await wrapped([]), "ok");
	assert.equal(captured.length, 0);
});
