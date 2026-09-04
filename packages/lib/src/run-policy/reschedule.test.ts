import { describe, expect, it, vi } from "vitest";
import {
	ensureNextRunScheduled,
	PROMPT_JOB_OPTIONS,
	PROMPT_RUN_MAX_SECONDS,
	promptChainSingletonKey,
	type RescheduleDeps,
} from "./reschedule";

const PROMPT = "11111111-2222-3333-4444-555555555555";

/**
 * A fake pg-boss chain store faithful to the production failure mode:
 * `send` with singletonSeconds resolves null whenever ANY job with the same
 * singleton key was created in the same throttle slot — including one that has
 * already completed (the slot does not care about state). `created` jobs are
 * the live chain.
 */
function chainStore(initial: { key: string; state: "created" | "completed" }[] = []) {
	const jobs = [...initial];
	let nextId = 1;
	const sentOptions: Record<string, unknown>[] = [];
	const deps: RescheduleDeps = {
		send: vi.fn(async (_queue, _data, options) => {
			sentOptions.push(options);
			const key = options.singletonKey as string;
			if (options.singletonSeconds !== undefined && jobs.some((j) => j.key === key)) return null;
			jobs.push({ key, state: "created" });
			return `job-${nextId++}`;
		}),
		hasScheduledChainJob: vi.fn(async (key) => jobs.some((j) => j.key === key && j.state === "created")),
	};
	return { jobs, deps, sentOptions, send: deps.send as ReturnType<typeof vi.fn> };
}

describe("ensureNextRunScheduled", () => {
	// F05R-F2 #1/#4 — a forced run completing while the canonical future chain
	// exists must not create a second chain: nothing is sent at all.
	it("keeps the existing future chain and sends nothing", async () => {
		const store = chainStore([{ key: promptChainSingletonKey(PROMPT), state: "created" }]);
		const outcome = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		expect(outcome).toEqual({ status: "existing" });
		expect(store.send).not.toHaveBeenCalled();
		expect(store.jobs.filter((j) => j.state === "created")).toHaveLength(1);
	});

	// F05R-F2 #2 — no future schedule: exactly one chain job is created.
	it("creates exactly one chain job when none exists", async () => {
		const store = chainStore();
		const outcome = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		expect(outcome).toMatchObject({ status: "scheduled" });
		expect(store.jobs).toHaveLength(1);
		expect(store.sentOptions[0]).toMatchObject({
			singletonKey: promptChainSingletonKey(PROMPT),
			startAfter: 12 * 3600,
			singletonSeconds: 12 * 3600,
		});
	});

	// F05R-F2 — the production chain-death bug: the throttle slot is occupied by
	// a COMPLETED job, send resolves null, and no live chain exists. The chain
	// must be revived, not silently dropped.
	it("revives the chain when the throttled send is nulled by a completed job", async () => {
		const store = chainStore([{ key: promptChainSingletonKey(PROMPT), state: "completed" }]);
		const outcome = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		expect(outcome).toMatchObject({ status: "revived" });
		expect(store.jobs.filter((j) => j.state === "created")).toHaveLength(1);
		// The revive send must not carry the slot throttle that nulled the first.
		expect(store.sentOptions[1].singletonSeconds).toBeUndefined();
	});

	// F05R-F2 #3 — two force requests in sequence leave exactly one future chain.
	it("leaves exactly one future chain after two sequential reschedules", async () => {
		const store = chainStore();
		const first = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		const second = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		expect(first).toMatchObject({ status: "scheduled" });
		expect(second).toEqual({ status: "existing" });
		expect(store.jobs.filter((j) => j.state === "created")).toHaveLength(1);
	});

	// F05R-F2 #5/#6 — every chain send carries the shared options: retryLimit 0
	// and the 90-minute production cycle expiry, from one source of truth.
	it("sends every chain job with retryLimit 0 and the 90-minute expiry", async () => {
		expect(PROMPT_RUN_MAX_SECONDS).toBe(90 * 60);
		expect(PROMPT_JOB_OPTIONS).toEqual({ retryLimit: 0, expireInSeconds: PROMPT_RUN_MAX_SECONDS });
		const throttled = chainStore([{ key: promptChainSingletonKey(PROMPT), state: "completed" }]);
		await ensureNextRunScheduled(PROMPT, 12, 0, throttled.deps);
		for (const options of throttled.sentOptions) {
			expect(options).toMatchObject({ retryLimit: 0, expireInSeconds: 90 * 60 });
		}
	});

	// F05R-F2 #7 — only the prompt's own singleton key is ever read or written;
	// another prompt's chain is untouched by key scoping.
	it("scopes every read and send to the prompt's own singleton key", async () => {
		const otherKey = promptChainSingletonKey("99999999-8888-7777-6666-555555555555");
		const store = chainStore([{ key: otherKey, state: "created" }]);
		const outcome = await ensureNextRunScheduled(PROMPT, 12, 0, store.deps);
		expect(outcome).toMatchObject({ status: "scheduled" });
		expect(store.deps.hasScheduledChainJob).toHaveBeenCalledWith(promptChainSingletonKey(PROMPT));
		for (const options of store.sentOptions) {
			expect(options.singletonKey).toBe(promptChainSingletonKey(PROMPT));
		}
		expect(store.jobs.filter((j) => j.key === otherKey)).toHaveLength(1);
	});

	// A racing sender that committed its chain between the null send and the
	// re-check is respected — no revive, no duplicate.
	it("does not revive when a racing sender already created the chain", async () => {
		const key = promptChainSingletonKey(PROMPT);
		let checks = 0;
		const send = vi.fn(async () => null);
		const outcome = await ensureNextRunScheduled(PROMPT, 12, 0, {
			send,
			hasScheduledChainJob: async () => ++checks === 2, // absent before send, present after
		});
		expect(outcome).toEqual({ status: "existing" });
		expect(send).toHaveBeenCalledTimes(1);
	});

	// The failure backoff still shortens the delay on failed cycles.
	it("applies the failure backoff to the chain delay", async () => {
		const store = chainStore();
		await ensureNextRunScheduled(PROMPT, 12, 1, store.deps);
		const startAfter = store.sentOptions[0].startAfter as number;
		expect(startAfter).toBeLessThan(12 * 3600);
		expect(startAfter).toBeGreaterThan(0);
	});
});
