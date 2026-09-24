import { type MaintenanceHeartbeat, writeMaintenanceHeartbeat } from "./alerts";
import type { Executor } from "./store";

/**
 * Sequencing of one maintenance tick: every stage runs in order, and the
 * durable heartbeat is written last, only when every stage succeeded. A
 * failing stage either aborts the tick (`onError: "throw"`, so the queue
 * retries it) or is recorded and lets the later stages run
 * (`onError: "record"`); in both cases the heartbeat is withheld, so its age
 * is honest evidence that the whole handler completed end-to-end.
 */

export interface MaintenanceStage {
	name: string;
	run: () => Promise<unknown>;
	onError: "throw" | "record";
}

export interface MaintenanceStageOutcome {
	name: string;
	ok: boolean;
	ms: number;
	errorName: string | null;
}

export interface MaintenanceTickResult {
	stages: MaintenanceStageOutcome[];
	heartbeatWritten: boolean;
}

export interface MaintenanceTickArgs {
	stages: MaintenanceStage[];
	heartbeat: Omit<MaintenanceHeartbeat, "v" | "stages">;
	executor?: Executor;
	/** Test seam; production writes the row through `writeMaintenanceHeartbeat`. */
	writeHeartbeat?: (heartbeat: MaintenanceHeartbeat) => Promise<void>;
}

export async function runMaintenanceTick(args: MaintenanceTickArgs): Promise<MaintenanceTickResult> {
	const outcomes: MaintenanceStageOutcome[] = [];
	for (const stage of args.stages) {
		const started = Date.now();
		try {
			await stage.run();
			outcomes.push({ name: stage.name, ok: true, ms: Date.now() - started, errorName: null });
		} catch (error) {
			outcomes.push({
				name: stage.name,
				ok: false,
				ms: Date.now() - started,
				errorName: error instanceof Error ? error.name : "error",
			});
			if (stage.onError === "throw") throw error;
		}
	}
	if (outcomes.some((o) => !o.ok)) return { stages: outcomes, heartbeatWritten: false };
	const heartbeat: MaintenanceHeartbeat = {
		v: 1,
		...args.heartbeat,
		stages: outcomes.map((o) => ({ name: o.name, ok: true as const, ms: o.ms })),
	};
	await (args.writeHeartbeat ?? ((h) => writeMaintenanceHeartbeat(h, args.executor)))(heartbeat);
	return { stages: outcomes, heartbeatWritten: true };
}
