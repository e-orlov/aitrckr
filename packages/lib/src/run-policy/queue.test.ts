import { describe, expect, it, vi } from "vitest";
import { ensurePromptQueue } from "./queue";
import { PROMPT_JOB_OPTIONS } from "./reschedule";

describe("ensurePromptQueue", () => {
	// SCHED-FR-003 — an existing queue's options are converged via the supported
	// updateQueue, since createQueue alone leaves a pre-existing queue's options
	// untouched. Existing jobs are never read, deleted, or recreated: the helper
	// has no access to anything but the two queue-admin calls.
	it("creates the queue if absent and updates it to the canonical policy", async () => {
		const calls: [string, string, object | undefined][] = [];
		await ensurePromptQueue({
			createQueue: vi.fn(async (name, options) => {
				calls.push(["create", name, options]);
			}),
			updateQueue: vi.fn(async (name, options) => {
				calls.push(["update", name, options]);
			}),
		});
		expect(calls).toEqual([
			["create", "process-prompt", PROMPT_JOB_OPTIONS],
			["update", "process-prompt", PROMPT_JOB_OPTIONS],
		]);
	});

	it("propagates queue-admin failures instead of hiding them", async () => {
		await expect(
			ensurePromptQueue({
				createQueue: async () => {},
				updateQueue: async () => {
					throw new Error("updateQueue unavailable");
				},
			}),
		).rejects.toThrow("updateQueue unavailable");
	});
});
