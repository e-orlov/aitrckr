import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CanaryGuardError,
	issueChildToken,
	normalizeExpectedSha256,
	readVerifiedContractFile,
	sha256Hex,
	verifyChildToken,
} from "../sentiment-canary-guard";

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sent01-canary-guard-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a contract file is accepted only when its raw bytes hash to the authorized digest", () => {
	withDir((dir) => {
		const path = join(dir, "contract.json");
		const bytes = Buffer.from('{"runId":"x"}\n', "utf8");
		writeFileSync(path, bytes);
		const digest = sha256Hex(bytes);
		assert.deepEqual(readVerifiedContractFile(path, digest.toUpperCase()), { raw: { runId: "x" }, sha256: digest });

		// The same JSON with different bytes (a trailing newline removed) is a different file.
		writeFileSync(path, '{"runId":"x"}');
		assert.throws(
			() => readVerifiedContractFile(path, digest),
			(e: unknown) => (e as CanaryGuardError).code === "contract-sha256-mismatch",
		);
		assert.throws(
			() => readVerifiedContractFile(path, "abc"),
			(e: unknown) => (e as CanaryGuardError).code === "contract-sha256-format",
		);
		assert.throws(
			() => readVerifiedContractFile(join(dir, "missing.json"), digest),
			(e: unknown) => (e as CanaryGuardError).code === "contract-unreadable",
		);
		writeFileSync(path, "not json");
		assert.throws(
			() => readVerifiedContractFile(path, sha256Hex("not json")),
			(e: unknown) => (e as CanaryGuardError).code === "contract-not-json",
		);
	});
	assert.equal(normalizeExpectedSha256(` ${"A".repeat(64)} `), "a".repeat(64));
	assert.throws(() => normalizeExpectedSha256(undefined), CanaryGuardError);
});

test("the child token verifies only the pair the supervisor issued", () => {
	const token = issueChildToken();
	assert.equal(verifyChildToken(token.secret, token.proof), true);
	assert.equal(verifyChildToken(undefined, token.proof), false);
	assert.equal(verifyChildToken(token.secret, undefined), false);
	assert.equal(verifyChildToken(token.secret, "deadbeef"), false);
	assert.equal(verifyChildToken(issueChildToken().secret, token.proof), false);
	assert.equal(verifyChildToken(token.proof, token.proof), false);
	assert.notEqual(issueChildToken().proof, token.proof);
});
