import { db } from "../db/db";
import { ALERT_SIGNALS, EVALUATOR_SIGNALS, HOST_SIGNALS, NOT_EVALUATED_HERE } from "./alert-registry";
import { type AlertStateSummary, type HeartbeatStatus, listAlertStates, readMaintenanceHeartbeat } from "./alerts";
import { databaseNow, listBlockingBreakers } from "./breaker";
import { type DispatchState, isHeld, listControlEvents, listPermits, readDispatchState } from "./controls";
import { listHeldWork } from "./held-release";
import type { Executor } from "./store";

/**
 * The versioned, deterministic `status --json` contract the host watchdog
 * (F2-PR-3) consumes. Every timestamp is the database clock; the report
 * carries the durable facts the host compares with its own observations
 * (heartbeat age, last evaluation, active/cooling alerts, acknowledgements)
 * and never asserts that a notification was delivered.
 */

export const STATUS_CONTRACT_VERSION = 1;

/**
 * Exit codes of `control:sentiment status`. `0`/`1`/`2`/`3` keep their CLI-wide
 * meanings (ok / error / usage / refused); the status-specific codes are:
 * `10` dispatch held and nothing worse, `20` an urgent alert is active
 * (unacknowledged), `30` the maintenance heartbeat is missing or stale,
 * `40` the status itself could not be produced. Precedence 40 > 30 > 20 > 10 > 0.
 */
export const STATUS_EXIT = { ok: 0, held: 10, urgent: 20, heartbeatStale: 30, failed: 40 } as const;

export interface SentimentStatusReport {
	contractVersion: typeof STATUS_CONTRACT_VERSION;
	generatedAt: string;
	dispatch: DispatchState;
	lastTransition: { seq: number; toState: string; actor: string; at: string } | null;
	breakers: { blocking: { scopeKey: string; state: string; openUntil: string | null; openedClass: string | null }[] };
	permits: { live: number; liveIds: string[] };
	heldWork: { pendingAnalyses: number; receiptsWithoutAnalysis: number; oldestAt: string | null };
	heartbeat: HeartbeatStatus;
	alerts: {
		registry: { total: number; evaluatorOwned: number; hostOwned: number };
		evaluatedHere: string[];
		notEvaluatedHere: { signal: string; owner: string; marker: typeof NOT_EVALUATED_HERE }[];
		active: AlertStateSummary[];
		cooling: AlertStateSummary[];
		acknowledged: AlertStateSummary[];
		all: AlertStateSummary[];
	};
	note: string;
}

export async function buildSentimentStatusReport(executor: Executor = db): Promise<SentimentStatusReport> {
	const dispatch = await readDispatchState(executor);
	const blocking = await listBlockingBreakers(executor);
	const live = await listPermits({ live: true }, executor);
	const held = await listHeldWork(0, executor);
	const events = await listControlEvents("control", "dispatch", executor);
	const heartbeat = await readMaintenanceHeartbeat(executor);
	const states = await listAlertStates(executor);
	const last = events.at(-1);
	return {
		contractVersion: STATUS_CONTRACT_VERSION,
		generatedAt: (await databaseNow(executor)).toISOString(),
		dispatch,
		lastTransition: last
			? { seq: last.seq, toState: last.toState, actor: last.actor, at: last.createdAt.toISOString() }
			: null,
		breakers: {
			blocking: blocking.map((b) => ({
				scopeKey: b.scopeKey,
				state: b.state,
				openUntil: b.openUntil?.toISOString() ?? null,
				openedClass: b.openedClass,
			})),
		},
		permits: { live: live.length, liveIds: live.map((p) => p.id) },
		heldWork: {
			pendingAnalyses: held.counts.a,
			receiptsWithoutAnalysis: held.counts.b,
			oldestAt: held.oldestAt?.toISOString() ?? null,
		},
		heartbeat,
		alerts: {
			registry: {
				total: ALERT_SIGNALS.length,
				evaluatorOwned: EVALUATOR_SIGNALS.length,
				hostOwned: HOST_SIGNALS.length,
			},
			evaluatedHere: EVALUATOR_SIGNALS.map((s) => s.signal),
			notEvaluatedHere: HOST_SIGNALS.map((s) => ({ signal: s.signal, owner: s.owner, marker: NOT_EVALUATED_HERE })),
			active: states.filter((s) => s.active),
			cooling: states.filter((s) => s.cooling),
			acknowledged: states.filter((s) => s.acknowledged),
			all: states,
		},
		note: "estimated budgets and reservations are planning figures, not hard dollar ceilings; alert-delivery-failure is decided by the host watchdog from this report",
	};
}

/** Pure exit-code selection from a report; the host maps it without parsing prose. */
export function statusExitCode(report: Pick<SentimentStatusReport, "dispatch" | "heartbeat" | "alerts">): number {
	if (!report.heartbeat.present || report.heartbeat.stale) return STATUS_EXIT.heartbeatStale;
	if (report.alerts.active.some((a) => a.severity === "urgent")) return STATUS_EXIT.urgent;
	if (isHeld(report.dispatch)) return STATUS_EXIT.held;
	return STATUS_EXIT.ok;
}
