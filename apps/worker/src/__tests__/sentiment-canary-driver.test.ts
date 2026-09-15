/**
 * Process-level refusals of the committed canary driver. Every case here must
 * end before the driver touches the database or a provider: DATABASE_URL
 * points at a closed port (any connection attempt would surface as an
 * ECONNREFUSED report rather than a refusal) and no provider key is set.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHILD_SECRET_ENV, issueChildToken, sha256Hex } from "../sentiment-canary-guard";

const DRIVER = join(__dirname, "..", "..", "scripts", "sentiment-canary.ts");
const RUN = "bf1347c3-7161-457c-91d6-0173d601659e";
const CONTRACT = {
	runId: RUN,
	promptId: "e32b0973-3b13-46c2-84dc-f29a6e5c41a2",
	brandId: "arag",
	answerBodySha256: "1".repeat(64),
	entities: [{ key: "brand", entityType: "brand" }],
	classifierInputHash: "2".repeat(64),
	providerPromptSha256: "3".repeat(64),
	classifierVersion: "sent-classifier-v3",
	taxonomyVersion: "sent-aspects-v1",
	evidenceVersion: "sent-evidence-v2",
	detectorVersion: "sent-detector-v2",
	provider: "openrouter",
	model: "openai/gpt-5-mini",
};

const baseEnv = (): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/dead" };
	delete env.OPENROUTER_API_KEY;
	delete env[CHILD_SECRET_ENV];
	return env;
};

function driver(args: string[], env: NodeJS.ProcessEnv = baseEnv()) {
	const result = spawnSync(process.execPath, ["--import", "tsx", DRIVER, ...args], {
		cwd: join(__dirname, "..", ".."),
		env,
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertNoWork(out: { stdout: string; stderr: string }) {
	const all = out.stdout + out.stderr;
	assert.doesNotMatch(all, /"preflight"/, "a canary report was produced");
	assert.doesNotMatch(all, /"supervisor"/, "the supervisor ran");
	assert.doesNotMatch(all, /ECONNREFUSED|connect|postgres/i, "the database was contacted");
	assert.doesNotMatch(all, /openrouter\.ai|provider-unconfigured/, "the provider path was reached");
	assert.doesNotMatch(all, /[0-9a-f]{64}/, "a digest or secret leaked into the output");
}

function withContract<T>(fn: (path: string, digest: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "sent01-canary-driver-"));
	try {
		const path = join(dir, "contract.json");
		const bytes = Buffer.from(JSON.stringify(CONTRACT, null, 2), "utf8");
		writeFileSync(path, bytes);
		return fn(path, sha256Hex(bytes));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("run without --contract-sha256 is a usage error before any work", { timeout: 150_000 }, () => {
	withContract((path) => {
		const out = driver(["run", "--contract", path, RUN]);
		assert.equal(out.status, 2, out.stderr);
		assert.match(out.stderr, /--contract-sha256 <64-hex> is required/);
		assertNoWork(out);
	});
});

test("a contract digest that does not match the file is refused by the supervisor before the child starts", {
	timeout: 150_000,
}, () => {
	withContract((path, digest) => {
		const wrong = digest.replace(/^./, digest[0] === "0" ? "1" : "0");
		const out = driver(["run", "--contract", path, "--contract-sha256", wrong, RUN]);
		assert.equal(out.status, 3, out.stderr);
		assert.match(out.stderr, /^refused: contract-sha256-mismatch/m);
		assertNoWork(out);
		const malformed = driver(["run", "--contract", path, "--contract-sha256", "abc", RUN]);
		assert.equal(malformed.status, 3);
		assert.match(malformed.stderr, /^refused: contract-sha256-format/m);
	});
});

test("child mode invoked directly, without the supervisor's token, is refused before contract, database or provider", {
	timeout: 150_000,
}, () => {
	withContract((path, digest) => {
		const bare = driver(["run", "--contract", path, "--contract-sha256", digest, RUN, "--child", "0".repeat(64)]);
		assert.equal(bare.status, 3, bare.stderr);
		assert.match(bare.stderr, /^refused: child-token/m);
		assertNoWork(bare);

		// A guessed proof without the matching secret in the environment fails the same way.
		const token = issueChildToken();
		const guessed = driver(["run", "--contract", path, "--contract-sha256", digest, RUN, "--child", token.proof]);
		assert.equal(guessed.status, 3, guessed.stderr);
		assert.match(guessed.stderr, /^refused: child-token/m);

		// A secret that does not match the proof fails too.
		const mismatched = driver(["run", "--contract", path, "--contract-sha256", digest, RUN, "--child", token.proof], {
			...baseEnv(),
			[CHILD_SECRET_ENV]: issueChildToken().secret,
		});
		assert.equal(mismatched.status, 3, mismatched.stderr);
		assert.match(mismatched.stderr, /^refused: child-token/m);
	});
});

test("a child with a valid token still re-verifies the contract file itself", { timeout: 150_000 }, () => {
	withContract((path, digest) => {
		const token = issueChildToken();
		const wrong = digest.replace(/^./, digest[0] === "0" ? "1" : "0");
		const out = driver(["run", "--contract", path, "--contract-sha256", wrong, RUN, "--child", token.proof], {
			...baseEnv(),
			[CHILD_SECRET_ENV]: token.secret,
		});
		assert.equal(out.status, 3, out.stderr);
		assert.match(out.stderr, /^refused: contract-sha256-mismatch/m);
		assertNoWork(out);
	});
});

test("a run id that is not the frozen one is refused before any work", { timeout: 150_000 }, () => {
	withContract((path, digest) => {
		const out = driver([
			"run",
			"--contract",
			path,
			"--contract-sha256",
			digest,
			"11111111-1111-4111-8111-111111111111",
		]);
		assert.equal(out.status, 3, out.stderr);
		assert.match(out.stderr, /^refused: not-frozen-run/m);
		assertNoWork(out);
	});
});
