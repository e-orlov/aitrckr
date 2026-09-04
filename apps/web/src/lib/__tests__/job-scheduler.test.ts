import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROMPT_JOB_OPTIONS } from "@workspace/lib/run-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The scheduler resolves cadence from the DB; an absent prompt falls back to
// the default cadence, which is all these tests need.
vi.mock("@workspace/lib/db/db", () => ({
	db: { query: { prompts: { findFirst: async () => undefined }, brands: { findFirst: async () => undefined } } },
}));

const sends: { queue: string; data: Record<string, unknown>; options: Record<string, unknown> }[] = [];
vi.mock("@/lib/boss-client", () => ({
	getBoss: async () => ({
		send: async (queue: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
			sends.push({ queue, data, options });
			return `job-${sends.length}`;
		},
		unschedule: async () => {},
	}),
}));

import { createPromptJobScheduler, sendImmediatePromptJob } from "@/lib/job-scheduler";

const PROMPT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
	sends.length = 0;
});

// SCHED-FR-002 — every process-prompt producer sends with the one shared
// policy: 90-minute expiry, no queue-level retry of a paid fan-out.
describe("process-prompt producers use the canonical policy", () => {
	it("createPromptJobScheduler with an immediate job", async () => {
		expect(await createPromptJobScheduler(PROMPT, { sendImmediate: true })).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].queue).toBe("process-prompt");
		expect(sends[0].options).toMatchObject(PROMPT_JOB_OPTIONS);
	});

	it("createPromptJobScheduler with a delayed first job", async () => {
		expect(await createPromptJobScheduler(PROMPT, { sendImmediate: false })).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].options).toMatchObject(PROMPT_JOB_OPTIONS);
		expect(sends[0].options.startAfter).toBeGreaterThan(0);
	});

	it("sendImmediatePromptJob without forceDue", async () => {
		expect(await sendImmediatePromptJob(PROMPT)).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].options).toEqual(PROMPT_JOB_OPTIONS);
		expect(sends[0].data.forceDue).toBeUndefined();
	});

	it("sendImmediatePromptJob with forceDue only bypasses the cadence gate", async () => {
		expect(await sendImmediatePromptJob(PROMPT, { forceDue: true })).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].data.forceDue).toBe(true);
		expect(sends[0].options).toEqual(PROMPT_JOB_OPTIONS);
	});
});

// SCHED-01 inventory guard — no producer or queue-init file reintroduces a
// local process-prompt policy beside the shared one.
describe("no local process-prompt policy literals remain", () => {
	const repoRoot = resolve(import.meta.dirname ?? __dirname, "..", "..", "..", "..", "..");
	const files = [
		join(repoRoot, "apps", "web", "src", "lib", "job-scheduler.ts"),
		join(repoRoot, "apps", "web", "src", "lib", "boss-client.ts"),
		join(repoRoot, "apps", "worker", "src", "index.ts"),
		join(repoRoot, "apps", "worker", "src", "jobs", "schedule-maintenance.ts"),
		join(repoRoot, "packages", "lib", "src", "run-policy", "reschedule.ts"),
	];

	it("no retry/expiry literal appears near a process-prompt send or queue call", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (!line.includes('"process-prompt"')) return;
				const window = lines.slice(i, i + 12).join("\n");
				// Every option block for process-prompt must come from PROMPT_JOB_OPTIONS.
				if (/retryLimit:\s*\d|retryDelay:\s*\d|retryBackoff:\s*(true|false)|expireInSeconds:\s*\d/.test(window)) {
					offenders.push(`${file}:${i + 1}`);
				}
			});
		}
		expect(offenders).toEqual([]);
	});
});
