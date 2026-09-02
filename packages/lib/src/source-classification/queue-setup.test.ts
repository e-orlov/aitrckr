import { describe, expect, it, vi } from "vitest";
import { ensureSourceClassificationQueue, SOURCE_CLASSIFICATION_QUEUE_OPTIONS } from "./queue-setup";
import { SOURCE_CLASSIFICATION_QUEUE } from "./types";

function admin(policy: string | null | undefined, queueExists = true) {
	const createQueue = vi.fn(async () => {});
	const getQueue = vi.fn(async () => (queueExists ? { policy } : null));
	return { boss: { createQueue, getQueue }, createQueue, getQueue };
}

describe("ensureSourceClassificationQueue", () => {
	it("creates the queue with the exclusive policy and verifies the effective policy", async () => {
		const { boss, createQueue, getQueue } = admin("exclusive");
		await ensureSourceClassificationQueue(boss);
		expect(SOURCE_CLASSIFICATION_QUEUE_OPTIONS.policy).toBe("exclusive");
		expect(createQueue).toHaveBeenCalledWith(SOURCE_CLASSIFICATION_QUEUE, SOURCE_CLASSIFICATION_QUEUE_OPTIONS);
		expect(getQueue).toHaveBeenCalledWith(SOURCE_CLASSIFICATION_QUEUE);
	});

	// F05-RC-AT-004 — an existing queue with a different immutable policy is a
	// hard failure with operator instructions, never silently accepted and never
	// deleted/recreated automatically.
	it("fails fast when the existing queue carries another (immutable) policy", async () => {
		for (const policy of ["standard", "short", "singleton", "stately", null, undefined]) {
			const { boss } = admin(policy);
			await expect(ensureSourceClassificationQueue(boss)).rejects.toThrow(/immutable|requires "exclusive"/);
		}
	});

	it("performs no destructive queue operation on mismatch (helper only creates and reads)", async () => {
		const { boss, createQueue, getQueue } = admin("standard");
		await ensureSourceClassificationQueue(boss).catch(() => {});
		// The narrow admin interface has no delete — assert nothing beyond
		// createQueue/getQueue was even invokable and both were called once.
		expect(createQueue).toHaveBeenCalledTimes(1);
		expect(getQueue).toHaveBeenCalledTimes(1);
	});

	it("fails when the queue is missing after createQueue", async () => {
		const { boss } = admin(undefined, false);
		await expect(ensureSourceClassificationQueue(boss)).rejects.toThrow(/missing after createQueue/);
	});
});
