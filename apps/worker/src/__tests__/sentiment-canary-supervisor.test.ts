import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { superviseCanaryChild } from "../sentiment-canary-supervisor";

const FIXTURE = join(__dirname, "fixtures", "stubborn-canary-child.mjs");

const isRunning = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withMarkers<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "sent01-canary-supervisor-"));
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a child that finishes in time is reported with its exit code and output", async () => {
	await withMarkers(async (dir) => {
		const accepted = await superviseCanaryChild({
			command: process.execPath,
			args: [FIXTURE, "accept", dir],
			watchdogMs: 10_000,
		});
		assert.equal(accepted.status, "exited");
		assert.equal(accepted.status === "exited" && accepted.exitCode, 0);
		assert.match(accepted.stdout, /"verdict":\{"status":"accept"\}/);

		const rejected = await superviseCanaryChild({
			command: process.execPath,
			args: [FIXTURE, "reject", dir],
			watchdogMs: 10_000,
		});
		assert.equal(rejected.status, "exited");
		assert.equal(rejected.status === "exited" && rejected.exitCode, 1);
	});
});

test("the watchdog kills a child that ignores termination, together with its grandchild, before any late side effect", async () => {
	await withMarkers(async (dir) => {
		const lateMs = 1_500;
		const started = Date.now();
		const result = await superviseCanaryChild({
			command: process.execPath,
			args: [FIXTURE, "hang", dir, String(lateMs)],
			watchdogMs: 400,
			killGraceMs: 3_000,
		});
		const elapsed = Date.now() - started;

		// The parent returned within the watchdog plus the kill, well before the late work was due.
		assert.equal(result.status, "killed");
		assert.ok(result.status === "killed" && result.treeKilled, "kill command must succeed");
		assert.ok(result.status === "killed" && result.exitObserved, "child exit must be observed");
		assert.ok(elapsed < lateMs, `parent took ${elapsed} ms, late work was due at ${lateMs} ms`);
		assert.ok(existsSync(join(dir, "started")));
		assert.ok(existsSync(join(dir, "provider-call-1")));

		// Child and grandchild are really gone.
		const childPid = Number(readFileSync(join(dir, "started"), "utf8"));
		const grandchildPid = Number(readFileSync(join(dir, "grandchild-pid"), "utf8"));
		await sleep(200);
		assert.equal(isRunning(childPid), false, "child still running");
		assert.equal(isRunning(grandchildPid), false, "grandchild still running");

		// Wait past the moment the late work would have happened: nothing appears.
		await sleep(lateMs + 500);
		assert.equal(existsSync(join(dir, "late-marker")), false, "late marker appeared after the kill");
		assert.equal(existsSync(join(dir, "provider-call-2")), false, "a second provider call happened");
		assert.equal(existsSync(join(dir, "grandchild-late")), false, "grandchild outlived the kill");
		assert.doesNotMatch(result.stdout, /"attempts":2/);
	});
});

test("a command that cannot be spawned is reported, not thrown", async () => {
	const result = await superviseCanaryChild({
		command: join(tmpdir(), "definitely-missing-executable-sent01"),
		args: [],
		watchdogMs: 1_000,
	});
	assert.equal(result.status, "spawn-error");
});
