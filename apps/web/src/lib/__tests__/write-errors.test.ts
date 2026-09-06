import { WriteDeniedError } from "@workspace/lib/entitlements";
import { describe, expect, it } from "vitest";
import { PROMPT_SAVE_FAILED, PublicError } from "@/lib/public-errors";
import { READ_ONLY_ERROR, READ_ONLY_MESSAGE, READ_ONLY_REFUSED } from "@/lib/read-only-errors";
import { writeErrorMessage } from "@/lib/write-errors";

const CANARY = "F04_R2_SECRET_CANARY";
const FALLBACK = PROMPT_SAVE_FAILED;

/** Everything a database error could leak; none of it may reach the screen. */
const LEAKS = ["Failed query", "insert into", '"prompts"', "params", CANARY, "DrizzleQueryError", "node_modules"];

function expectOnlyFallback(message: string) {
	expect(message).toBe(FALLBACK);
	for (const leak of LEAKS) expect(message).not.toContain(leak);
}

// SE-001 / SE-002 — a message is never trusted just because it exists.
describe("writeErrorMessage denies by default", () => {
	it("hides a Drizzle query failure, including the SQL and the parameters", () => {
		const error = new Error(
			`Failed query: insert into "prompts" ("id", "brand_id", "value", "tags") values (default, $1, $2, $3)\nparams: arag,${CANARY},{rechtsschutz}`,
		);
		expectOnlyFallback(writeErrorMessage(error, FALLBACK, false));
	});

	it("hides a PostgreSQL driver error", () => {
		const error = Object.assign(new Error(`duplicate key value violates unique constraint "prompts_pkey" ${CANARY}`), {
			code: "23505",
			detail: `Key (id)=(${CANARY}) already exists.`,
			schema: "public",
			table: "prompts",
		});
		expectOnlyFallback(writeErrorMessage(error, FALLBACK, false));
	});

	it("hides an error that carries a stack and a cause", () => {
		const cause = new Error(`connection refused ${CANARY}`);
		const error = new Error(`Failed query: update "prompts" set "tags" = $1 ${CANARY}`, { cause });
		error.stack = `Error: ${CANARY}\n    at savePromptsForBrand (/app/apps/web/src/server/save-prompts.ts:44:9)`;
		expectOnlyFallback(writeErrorMessage(error, FALLBACK, false));
	});

	it.each([
		["a string", `Failed query: ${CANARY}`],
		["a plain object", { message: `Failed query: ${CANARY}`, code: "42P01" }],
		["null", null],
		["undefined", undefined],
		["an error without a message", new Error("")],
	])("falls back for %s", (_label, error) => {
		expectOnlyFallback(writeErrorMessage(error, FALLBACK, false));
	});

	it("does not treat a readable unknown message as public", () => {
		expect(writeErrorMessage(new Error("Brand not found"), FALLBACK, false)).toBe(FALLBACK);
		expect(writeErrorMessage(new Error("Something went wrong, please retry"), FALLBACK, false)).toBe(FALLBACK);
	});

	it("does not trust a message that merely claims to be public", () => {
		const impostor = Object.assign(new Error(`Failed query ${CANARY}`), { publicError: "yes", code: 42 });
		expectOnlyFallback(writeErrorMessage(impostor, FALLBACK, false));
	});
});

describe("writeErrorMessage shows what is meant for the user", () => {
	it("keeps the read-only refusal", () => {
		expect(writeErrorMessage(new Error(READ_ONLY_MESSAGE), FALLBACK, false)).toBe(READ_ONLY_REFUSED);
		expect(writeErrorMessage(new Error(`${READ_ONLY_ERROR}: blocked`), FALLBACK, false)).toBe(READ_ONLY_REFUSED);
	});

	it("uses the read-only refusal for any failure on a read-only deployment", () => {
		expect(writeErrorMessage(new Error(`Failed query ${CANARY}`), FALLBACK, true)).toBe(READ_ONLY_REFUSED);
	});

	it("shows a public domain error's message", () => {
		const error = new PublicError("slug-taken", "That URL Slug is already taken.");
		expect(writeErrorMessage(error, FALLBACK, false)).toBe("That URL Slug is already taken.");
	});

	it("shows a public error that crossed the wire as a plain Error with the envelope", () => {
		const wire = Object.assign(new Error("Prompt x appears twice in this save."), {
			name: "PublicError",
			publicError: true,
			code: "prompt-save-plan",
		});
		expect(writeErrorMessage(wire, FALLBACK, false)).toBe("Prompt x appears twice in this save.");
	});

	it("shows an entitlement denial", () => {
		const error = new WriteDeniedError("prompt-cap", "A brand can have at most 100 prompts.");
		expect(writeErrorMessage(error, FALLBACK, false)).toBe("A brand can have at most 100 prompts.");
		const wire = Object.assign(new Error("A brand can have at most 100 prompts."), {
			name: "WriteDeniedError",
			code: "prompt-cap",
			status: 409,
			error: "Conflict",
		});
		expect(writeErrorMessage(wire, FALLBACK, false)).toBe("A brand can have at most 100 prompts.");
	});
});

describe("PublicError", () => {
	it("carries only what the client needs across the wire", () => {
		const error = new PublicError("prompt-save-failed", PROMPT_SAVE_FAILED);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(PROMPT_SAVE_FAILED);
		expect(Object.keys(error).sort()).toEqual(["code", "name", "publicError"]);
		expect("stack" in error).toBe(false);
		expect(error.cause).toBeUndefined();
	});
});
