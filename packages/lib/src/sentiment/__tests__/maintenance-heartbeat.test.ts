import { describe, expect, it, vi } from "vitest";
import type { MaintenanceHeartbeat } from "../alerts";
import { runMaintenanceTick } from "../maintenance-heartbeat";

const heartbeat = { workerBootId: "boot-1", source: "scheduled", alerts: null };

describe("maintenance tick sequencing: the heartbeat is written last and only on a complete tick", () => {
	it("runs every stage in order and writes one heartbeat after the last stage", async () => {
		const order: string[] = [];
		const write = vi.fn(async (h: MaintenanceHeartbeat) => {
			order.push("heartbeat");
			expect(h.stages.map((s) => s.name)).toEqual(["prompt-schedule", "sentiment-wakeup", "sentiment-alerts"]);
			expect(h.stages.every((s) => s.ok)).toBe(true);
			expect(h).toMatchObject({ v: 1, workerBootId: "boot-1", source: "scheduled" });
		});
		const stage = (name: string) => ({ name, onError: "record" as const, run: async () => void order.push(name) });
		const result = await runMaintenanceTick({
			heartbeat,
			stages: [{ ...stage("prompt-schedule"), onError: "throw" }, stage("sentiment-wakeup"), stage("sentiment-alerts")],
			writeHeartbeat: write,
		});
		expect(order).toEqual(["prompt-schedule", "sentiment-wakeup", "sentiment-alerts", "heartbeat"]);
		expect(result.heartbeatWritten).toBe(true);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("a recorded stage failure lets the later stages run but withholds the heartbeat", async () => {
		const order: string[] = [];
		const write = vi.fn(async () => void order.push("heartbeat"));
		const result = await runMaintenanceTick({
			heartbeat,
			stages: [
				{ name: "a", onError: "throw", run: async () => void order.push("a") },
				{
					name: "b",
					onError: "record",
					run: async () => {
						order.push("b");
						throw new TypeError("wake-up failed");
					},
				},
				{ name: "c", onError: "record", run: async () => void order.push("c") },
			],
			writeHeartbeat: write,
		});
		expect(order).toEqual(["a", "b", "c"]);
		expect(write).not.toHaveBeenCalled();
		expect(result).toEqual({
			heartbeatWritten: false,
			stages: [
				{ name: "a", ok: true, ms: expect.any(Number), errorName: null },
				{ name: "b", ok: false, ms: expect.any(Number), errorName: "TypeError" },
				{ name: "c", ok: true, ms: expect.any(Number), errorName: null },
			],
		});
	});

	it("a throwing stage aborts the tick for the queue to retry, without a heartbeat and without later stages", async () => {
		const order: string[] = [];
		const write = vi.fn(async () => void order.push("heartbeat"));
		await expect(
			runMaintenanceTick({
				heartbeat,
				stages: [
					{
						name: "prompt-schedule",
						onError: "throw",
						run: async () => {
							order.push("prompt-schedule");
							throw new Error("db down");
						},
					},
					{ name: "sentiment-alerts", onError: "record", run: async () => void order.push("sentiment-alerts") },
				],
				writeHeartbeat: write,
			}),
		).rejects.toThrow("db down");
		expect(order).toEqual(["prompt-schedule"]);
		expect(write).not.toHaveBeenCalled();
	});

	it("a failing final stage leaves the heartbeat unwritten even though every earlier stage succeeded", async () => {
		const write = vi.fn(async () => {});
		const result = await runMaintenanceTick({
			heartbeat,
			stages: [
				{ name: "a", onError: "record", run: async () => {} },
				{
					name: "sentiment-alerts",
					onError: "record",
					run: async () => {
						throw new Error("evaluation failed");
					},
				},
			],
			writeHeartbeat: write,
		});
		expect(result.heartbeatWritten).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});
});
