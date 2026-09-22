import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/db";
import {
	type SentimentControlEvent,
	type SentimentDispatchPermit,
	sentimentControlEvents,
	sentimentControls,
	sentimentDispatchPermits,
	sentimentProviderAttempts,
} from "../db/schema";
import type { Executor } from "./store";
import { SENTIMENT_MODEL, SENTIMENT_PROVIDER_ID } from "./types";

/**
 * Dispatch safety controls (ADR-SENT-01-GROUNDED-COMPLETION, Amendment C):
 * the durable sentiment dispatch hold, its append-only audit and the permits
 * that are the only bypass of a held dispatch. Every transition is a
 * compare-and-swap on the row it moves plus one event row in the same
 * transaction; nothing here ever calls a provider.
 */

export const DISPATCH_CONTROL_KEY = "dispatch";
export const DISPATCH_STATES = ["held", "open"] as const;
export type DispatchControlState = (typeof DISPATCH_STATES)[number];

export type DispatchState =
	| { state: DispatchControlState; epoch: number; readable: true }
	/** The row is absent, malformed or could not be read: dispatch is held. */
	| { state: "held"; epoch: null; readable: false; error: string };

export const isHeld = (state: DispatchState): boolean => state.state === "held";

/**
 * The current dispatch state, failing closed: an absent row, an unknown state
 * value or any read error is reported as `held` and never thrown, so a gate
 * that cannot see the control refuses to dispatch.
 */
export async function readDispatchState(executor: Executor = db): Promise<DispatchState> {
	try {
		const row = await executor.query.sentimentControls.findFirst({
			where: eq(sentimentControls.key, DISPATCH_CONTROL_KEY),
		});
		if (!row) return { state: "held", epoch: null, readable: false, error: "control-row-missing" };
		if (row.state !== "held" && row.state !== "open") {
			return { state: "held", epoch: null, readable: false, error: `control-state-unknown:${String(row.state)}` };
		}
		return { state: row.state, epoch: row.epoch, readable: true };
	} catch (error) {
		return {
			state: "held",
			epoch: null,
			readable: false,
			error: error instanceof Error ? error.name : "control-read-failed",
		};
	}
}

export interface ControlActor {
	actor: string;
	reason: string;
	correlationId: string;
}

const ACTOR_MAX = 120;
const REASON_MAX = 500;

/** Actor, reason and correlation are mandatory, bounded plain text; a mutating command without them is refused. */
export function requireActor(input: Partial<ControlActor>): ControlActor {
	const actor = input.actor?.trim() ?? "";
	const reason = input.reason?.trim() ?? "";
	const correlationId = input.correlationId?.trim() ?? "";
	if (!actor || actor.length > ACTOR_MAX) throw new Error(`actor is required (1-${ACTOR_MAX} characters)`);
	if (!reason || reason.length > REASON_MAX) throw new Error(`reason is required (1-${REASON_MAX} characters)`);
	if (!correlationId || correlationId.length > ACTOR_MAX)
		throw new Error(`correlation id is required (1-${ACTOR_MAX} characters)`);
	return { actor, reason, correlationId };
}

export type ControlSubjectKind = "control" | "permit" | "breaker" | "alert";

/**
 * Append one audit row for a subject. The caller holds the subject's row lock
 * (it updates the subject in the same transaction), so the dense `seq` cannot
 * race; the unique index refuses any duplicate that would slip through.
 */
export async function appendControlEvent(
	tx: Executor,
	event: {
		subjectKind: ControlSubjectKind;
		subjectKey: string;
		fromState: string | null;
		toState: string;
		evidence?: Record<string, unknown> | null;
	} & ControlActor,
): Promise<SentimentControlEvent> {
	const [{ next }] = await tx
		.select({ next: sql<number>`coalesce(max(${sentimentControlEvents.seq}), 0)::int + 1` })
		.from(sentimentControlEvents)
		.where(
			and(
				eq(sentimentControlEvents.subjectKind, event.subjectKind),
				eq(sentimentControlEvents.subjectKey, event.subjectKey),
			),
		);
	const [row] = await tx
		.insert(sentimentControlEvents)
		.values({
			subjectKind: event.subjectKind,
			subjectKey: event.subjectKey,
			seq: next,
			fromState: event.fromState,
			toState: event.toState,
			actor: event.actor,
			reason: event.reason,
			correlationId: event.correlationId,
			evidence: event.evidence ?? null,
		})
		.returning();
	return row;
}

export type DispatchTransition =
	| { ok: true; epoch: number; from: DispatchControlState; to: DispatchControlState }
	| { ok: false; current: DispatchControlState | null };

/**
 * Compare-and-swap the dispatch control: the row must currently be in
 * `expected`; the transition bumps the epoch and appends the audit event in
 * one transaction. Repeating a command finds the row already moved and is
 * refused without writing anything.
 */
export async function transitionDispatch(
	args: { to: DispatchControlState; expected: DispatchControlState } & ControlActor,
	executor: Executor = db,
): Promise<DispatchTransition> {
	const who = requireActor(args);
	return executor.transaction(async (tx) => {
		const [moved] = await tx
			.update(sentimentControls)
			.set({
				state: args.to,
				epoch: sql`${sentimentControls.epoch} + 1`,
				changedAt: sql`now()`,
				actor: who.actor,
				reason: who.reason,
				correlationId: who.correlationId,
			})
			.where(and(eq(sentimentControls.key, DISPATCH_CONTROL_KEY), eq(sentimentControls.state, args.expected)))
			.returning({ epoch: sentimentControls.epoch });
		if (!moved) {
			const current = await tx.query.sentimentControls.findFirst({
				where: eq(sentimentControls.key, DISPATCH_CONTROL_KEY),
			});
			const state = current?.state === "held" || current?.state === "open" ? current.state : null;
			return { ok: false, current: state };
		}
		await appendControlEvent(tx, {
			subjectKind: "control",
			subjectKey: DISPATCH_CONTROL_KEY,
			fromState: args.expected,
			toState: args.to,
			evidence: { epoch: moved.epoch },
			...who,
		});
		return { ok: true, epoch: moved.epoch, from: args.expected, to: args.to };
	});
}

// ---------------------------------------------------------------------------
// Permits
// ---------------------------------------------------------------------------

export const PERMIT_PURPOSES = ["canary", "resume-verify"] as const;
export type PermitPurpose = (typeof PERMIT_PURPOSES)[number];
export const PERMIT_PHASES = ["classify", "repair", "verify"] as const;
export type PermitPhase = (typeof PERMIT_PHASES)[number];
export type PhaseBudget = Record<PermitPhase, 0 | 1>;

/**
 * Planning estimates reserved against a permit before each request (owner
 * decision D19). They are not prices and not caps: the enforceable limits are
 * the per-phase budget, the request token and tool limits, the expiry and the
 * fencing. Re-derived from settled costs after the first 20 verified
 * lifecycles.
 */
export const RESERVATION_ESTIMATES_USD: Readonly<Record<PermitPhase, number>> = Object.freeze({
	classify: 0.05,
	repair: 0.02,
	verify: 0.02,
});

/** Largest estimated cost budget a permit may carry (also enforced by the table CHECK). */
export const PERMIT_ESTIMATED_BUDGET_MAX_USD = 0.1;

export interface IssuePermitArgs extends ControlActor {
	purpose: PermitPurpose;
	promptRunId: string;
	analysisId: string;
	instanceId: string;
	inputHash: string;
	classifierVersion: string;
	phaseBudget: PhaseBudget;
	estimatedCostBudgetUsd: number;
	ttlSeconds: number;
	contractSha256?: string | null;
}

const money = (value: number): string => value.toFixed(6);

/** The states in which a permit row may still authorize a call (subject to its expiry by the database clock). */
export const PERMIT_LIVE_STATES = ["issued", "active"] as const;

/** The only phase budget a resume permit may carry at issue time. */
export const RESUME_VERIFY_PHASE_BUDGET: Readonly<PhaseBudget> = Object.freeze({ classify: 0, repair: 0, verify: 1 });

export const isResumeVerifyBudget = (budget: PhaseBudget): boolean =>
	budget.classify === 0 && budget.repair === 0 && budget.verify === 1;

/** Live state and unexpired by the given database clock: what "live" means everywhere a permit is read. */
export function isPermitEffective(permit: { state: string; expiresAt: Date }, databaseNow: Date): boolean {
	return (
		(PERMIT_LIVE_STATES as readonly string[]).includes(permit.state) &&
		permit.expiresAt.getTime() > databaseNow.getTime()
	);
}

/**
 * A live-state permit already occupies this lifecycle and cannot be replaced
 * automatically: it is still valid (`permit-live`), it has consumed a phase
 * (`permit-consumed`, whether or not it has since expired), or one of its
 * attempts is still `sending` (`permit-unresolved-attempt`). Each is the
 * operator's decision — revoke, reconcile — never the issuer's.
 */
export class PermitConflictError extends Error {
	constructor(
		readonly code: "permit-live" | "permit-consumed" | "permit-unresolved-attempt",
		readonly permitId: string,
	) {
		super(`cannot issue a permit: ${code} (${permitId})`);
		this.name = "PermitConflictError";
	}
}

/**
 * The live-state permits of one lifecycle, locked, with their expiry by the
 * database clock and whether an unresolved `sending` attempt references them.
 * In a single-table select Drizzle renders every column object inside a
 * selection expression as a bare identifier, so the correlated lookup names
 * its tables explicitly: the outer permit id and the aliased attempts table.
 */
export function lockedLifecyclePermits(tx: Executor, args: { analysisId: string; instanceId: string }) {
	const permitId = sql`${sentimentDispatchPermits}.${sql.identifier(sentimentDispatchPermits.id.name)}`;
	return tx
		.select({
			id: sentimentDispatchPermits.id,
			state: sentimentDispatchPermits.state,
			expired: sql<boolean>`${sentimentDispatchPermits.expiresAt} <= now()`,
			sending: sql<boolean>`exists (select 1 from ${sentimentProviderAttempts} as unresolved where unresolved.${sql.identifier(sentimentProviderAttempts.permitId.name)} = ${permitId} and unresolved.${sql.identifier(sentimentProviderAttempts.outcome.name)} = 'sending')`,
		})
		.from(sentimentDispatchPermits)
		.where(
			and(
				eq(sentimentDispatchPermits.analysisId, args.analysisId),
				eq(sentimentDispatchPermits.instanceId, args.instanceId),
				inArray(sentimentDispatchPermits.state, [...PERMIT_LIVE_STATES]),
			),
		)
		.orderBy(sentimentDispatchPermits.id)
		.for("update");
}

/**
 * Durably expire the unconsumed (`issued`) permits of a lifecycle whose
 * `expires_at` has passed by the database clock, one audit event each. Runs
 * inside the caller's transaction with the rows locked, so a concurrent issuer
 * or consumer sees the transition — and only a transaction that commits (the
 * issue, replacement and resume-apply paths) makes it durable. Permits that
 * consumed a phase or carry an unresolved `sending` attempt are never touched
 * here; they are reported as blocking with their typed reason.
 */
export async function expireUnconsumedPermits(
	tx: Executor,
	args: { analysisId: string; instanceId: string },
): Promise<{ expired: string[]; blocking: { id: string; code: PermitConflictError["code"] }[] }> {
	const live = await lockedLifecyclePermits(tx, args);
	const expired: string[] = [];
	const blocking: { id: string; code: PermitConflictError["code"] }[] = [];
	for (const permit of live) {
		if (permit.sending) blocking.push({ id: permit.id, code: "permit-unresolved-attempt" });
		else if (!permit.expired) blocking.push({ id: permit.id, code: "permit-live" });
		else if (permit.state !== "issued") blocking.push({ id: permit.id, code: "permit-consumed" });
		else {
			await tx
				.update(sentimentDispatchPermits)
				.set({ state: "expired" })
				.where(and(eq(sentimentDispatchPermits.id, permit.id), eq(sentimentDispatchPermits.state, "issued")));
			await appendControlEvent(tx, {
				subjectKind: "permit",
				subjectKey: permit.id,
				fromState: "issued",
				toState: "expired",
				evidence: { reason: "expires_at passed by the database clock before any phase was consumed" },
				actor: "system:permit-expiry",
				reason: "unconsumed permit expired",
				correlationId: "amendment-c",
			});
			expired.push(permit.id);
		}
	}
	return { expired, blocking };
}

function validatePermitShape(args: IssuePermitArgs): void {
	if (!PERMIT_PURPOSES.includes(args.purpose)) throw new Error(`unknown permit purpose "${args.purpose}"`);
	for (const phase of PERMIT_PHASES) {
		const v = args.phaseBudget[phase];
		if (v !== 0 && v !== 1) throw new Error(`phase budget for ${phase} must be 0 or 1`);
	}
	if (!Object.values(args.phaseBudget).some((v) => v === 1)) throw new Error("a permit must allow at least one phase");
	if (args.purpose === "resume-verify") {
		if (!isResumeVerifyBudget(args.phaseBudget)) {
			throw new Error('a resume-verify permit must carry exactly {"classify":0,"repair":0,"verify":1}');
		}
		if (!args.contractSha256 || !/^[0-9a-f]{64}$/i.test(args.contractSha256)) {
			throw new Error("a resume-verify permit must be bound to the sha256 of the frozen manifest it was issued from");
		}
	}
	if (
		!Number.isFinite(args.estimatedCostBudgetUsd) ||
		args.estimatedCostBudgetUsd <= 0 ||
		args.estimatedCostBudgetUsd > PERMIT_ESTIMATED_BUDGET_MAX_USD
	) {
		throw new Error(`estimated cost budget must be in (0, ${PERMIT_ESTIMATED_BUDGET_MAX_USD}] USD`);
	}
	if (!Number.isInteger(args.ttlSeconds) || args.ttlSeconds <= 0) throw new Error("ttl must be a positive integer");
}

/**
 * Issue the one live permit of a lifecycle. Bound to the analysis, its
 * current instance and the exact input; a resume permit is additionally
 * verify-only and bound to its manifest. An expired, unconsumed permit of the
 * same lifecycle is expired durably in the same transaction (one audit event)
 * before the replacement is inserted; any other live-state permit refuses the
 * issue with a typed {@link PermitConflictError}. The partial unique index
 * remains the last guard against a concurrent issuer. The estimated budget is
 * a planning figure bounded by {@link PERMIT_ESTIMATED_BUDGET_MAX_USD}.
 */
export async function issuePermit(args: IssuePermitArgs, executor: Executor = db): Promise<SentimentDispatchPermit> {
	const who = requireActor(args);
	validatePermitShape(args);
	return executor.transaction(async (tx) => {
		const stale = await expireUnconsumedPermits(tx, { analysisId: args.analysisId, instanceId: args.instanceId });
		if (stale.blocking.length > 0) throw new PermitConflictError(stale.blocking[0].code, stale.blocking[0].id);
		const [row] = await tx
			.insert(sentimentDispatchPermits)
			.values({
				purpose: args.purpose,
				promptRunId: args.promptRunId,
				analysisId: args.analysisId,
				instanceId: args.instanceId,
				inputHash: args.inputHash,
				classifierVersion: args.classifierVersion,
				provider: SENTIMENT_PROVIDER_ID,
				model: SENTIMENT_MODEL,
				phaseBudget: args.phaseBudget,
				estimatedCostBudgetUsd: money(args.estimatedCostBudgetUsd),
				expiresAt: sql`now() + make_interval(secs => ${args.ttlSeconds})`,
				issuedBy: who.actor,
				reason: who.reason,
				correlationId: who.correlationId,
				contractSha256: args.contractSha256 ?? null,
			})
			.returning();
		await appendControlEvent(tx, {
			subjectKind: "permit",
			subjectKey: row.id,
			fromState: null,
			toState: "issued",
			evidence: {
				purpose: args.purpose,
				analysisId: args.analysisId,
				instanceId: args.instanceId,
				phaseBudget: args.phaseBudget,
				estimatedCostBudgetUsd: money(args.estimatedCostBudgetUsd),
				contractSha256: args.contractSha256 ?? null,
				replacedExpired: stale.expired,
			},
			...who,
		});
		return row;
	});
}

/** One permit row by id (the boundary guard's re-authorization read). */
export async function loadPermit(id: string, executor: Executor = db): Promise<SentimentDispatchPermit | null> {
	const row = await executor.query.sentimentDispatchPermits.findFirst({ where: eq(sentimentDispatchPermits.id, id) });
	return row ?? null;
}

/** Which phases a permit's purpose may ever authorize, independent of the remaining budget. */
export function permitPurposeAllowsPhase(purpose: string, phase: PermitPhase): boolean {
	return purpose === "resume-verify" ? phase === "verify" : purpose === "canary";
}

/** The live permit bound to exactly this instance and input, if any (expiry judged by the database clock). */
export async function findLivePermit(
	args: { analysisId: string; instanceId: string; inputHash: string },
	executor: Executor = db,
): Promise<SentimentDispatchPermit | null> {
	const rows = await executor
		.select()
		.from(sentimentDispatchPermits)
		.where(
			and(
				eq(sentimentDispatchPermits.analysisId, args.analysisId),
				eq(sentimentDispatchPermits.instanceId, args.instanceId),
				eq(sentimentDispatchPermits.inputHash, args.inputHash),
				inArray(sentimentDispatchPermits.state, ["issued", "active"]),
				sql`${sentimentDispatchPermits.expiresAt} > now()`,
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export type PermitConsumption =
	| { consumed: true; permitId: string; reservedEstimateUsd: number }
	| { consumed: false; reason: "no-live-permit" | "phase-exhausted" | "estimate-budget-exhausted" | "expired" };

/**
 * Consume one call of `phase` from the live permit of this instance, inside
 * the caller's transaction and before the `sending` attempt row is written.
 * One conditional UPDATE decides everything: the permit must be live and
 * unexpired by the database clock, the phase budget must be 1, and the
 * planning predicate `settled + reserved + estimate ≤ budget` must hold. A
 * loser of a race sees zero rows and is told why; a refusal persists nothing
 * because the caller rolls the dispatch transaction back.
 */
export async function consumePermitPhase(
	tx: Executor,
	args: { analysisId: string; instanceId: string; inputHash: string; phase: PermitPhase; reserveUsd: number },
): Promise<PermitConsumption> {
	const reserve = money(args.reserveUsd);
	const [row] = await tx
		.update(sentimentDispatchPermits)
		.set({
			phaseBudget: sql`jsonb_set(${sentimentDispatchPermits.phaseBudget}, ${sql.raw(`'{${args.phase}}'`)}, '0'::jsonb)`,
			reservedEstimateUsd: sql`${sentimentDispatchPermits.reservedEstimateUsd} + ${reserve}::numeric`,
			state: "active",
		})
		.where(
			and(
				eq(sentimentDispatchPermits.analysisId, args.analysisId),
				eq(sentimentDispatchPermits.instanceId, args.instanceId),
				eq(sentimentDispatchPermits.inputHash, args.inputHash),
				inArray(sentimentDispatchPermits.state, ["issued", "active"]),
				sql`${sentimentDispatchPermits.expiresAt} > now()`,
				sql`coalesce((${sentimentDispatchPermits.phaseBudget}->>${args.phase})::int, 0) = 1`,
				sql`${sentimentDispatchPermits.settledCostUsd} + ${sentimentDispatchPermits.reservedEstimateUsd} + ${reserve}::numeric <= ${sentimentDispatchPermits.estimatedCostBudgetUsd}`,
			),
		)
		.returning({ id: sentimentDispatchPermits.id });
	if (row) return { consumed: true, permitId: row.id, reservedEstimateUsd: args.reserveUsd };
	const live = await findLivePermit(args, tx);
	if (!live) {
		// Diagnostic only: the caller rolls this transaction back on a refusal, so nothing observed here becomes
		// durable. The lifecycle's permits are classified to name the reason — a live-state permit that failed the
		// clock predicate or already consumed a phase is reported as `expired`; its stored row is left for the
		// committed issue/replacement/apply path (or the operator) to transition.
		const stale = await expireUnconsumedPermits(tx, { analysisId: args.analysisId, instanceId: args.instanceId });
		const any = stale.expired.length > 0 || stale.blocking.some((b) => b.code !== "permit-live");
		return { consumed: false, reason: any ? "expired" : "no-live-permit" };
	}
	const budget = live.phaseBudget as Partial<Record<string, number>>;
	if ((budget[args.phase] ?? 0) !== 1) return { consumed: false, reason: "phase-exhausted" };
	return { consumed: false, reason: "estimate-budget-exhausted" };
}

/**
 * How one attempt ended, as far as the permit's planning ledger is concerned:
 *  - `unpaid`: the request demonstrably cost nothing (local or structured refusal, guard abort) — the reservation is released;
 *  - `paid`: the provider charged a known amount — the reservation is released and the amount settled;
 *  - `paid-unknown-cost`: the provider answered but reported no cost — the reservation stays counted against the
 *    budget and nothing is settled, so an unpriced call is never mistaken for a free one.
 * An attempt whose outcome is unknown is not settled at all (reconciliation keeps its reservation).
 */
export type PermitSettlement =
	| { kind: "unpaid" }
	| { kind: "paid"; actualCostUsd: number }
	| { kind: "paid-unknown-cost" };

export function permitSettlementFor(paid: boolean, actualCostUsd: number | null): PermitSettlement {
	if (!paid) return { kind: "unpaid" };
	return actualCostUsd === null ? { kind: "paid-unknown-cost" } : { kind: "paid", actualCostUsd };
}

/**
 * Settle the permit side of one attempt per {@link PermitSettlement}. When
 * every phase is spent the permit becomes `exhausted`; a permit is never
 * refunded here — a dangling `sending` attempt keeps its reservation until an
 * operator reconciles it.
 */
export async function settlePermitReservation(
	tx: Executor,
	args: { permitId: string; reservedEstimateUsd: number; settlement: PermitSettlement },
): Promise<void> {
	const releases = args.settlement.kind !== "paid-unknown-cost";
	const actual = money(args.settlement.kind === "paid" ? Math.max(0, args.settlement.actualCostUsd) : 0);
	await tx
		.update(sentimentDispatchPermits)
		.set({
			reservedEstimateUsd: releases
				? sql`greatest(${sentimentDispatchPermits.reservedEstimateUsd} - ${money(args.reservedEstimateUsd)}::numeric, 0)`
				: sentimentDispatchPermits.reservedEstimateUsd,
			settledCostUsd: sql`${sentimentDispatchPermits.settledCostUsd} + ${actual}::numeric`,
			state: sql`case when coalesce((${sentimentDispatchPermits.phaseBudget}->>'classify')::int,0) + coalesce((${sentimentDispatchPermits.phaseBudget}->>'repair')::int,0) + coalesce((${sentimentDispatchPermits.phaseBudget}->>'verify')::int,0) = 0 then 'exhausted' else ${sentimentDispatchPermits.state} end`,
		})
		.where(eq(sentimentDispatchPermits.id, args.permitId));
}

/** Revoke a live permit (operator). Idempotent: an already inactive permit is reported, not changed. */
export async function revokePermit(
	args: { permitId: string } & ControlActor,
	executor: Executor = db,
): Promise<{ revoked: boolean; state: string | null }> {
	const who = requireActor(args);
	return executor.transaction(async (tx) => {
		const [row] = await tx
			.update(sentimentDispatchPermits)
			.set({ state: "revoked" })
			.where(
				and(
					eq(sentimentDispatchPermits.id, args.permitId),
					inArray(sentimentDispatchPermits.state, ["issued", "active"]),
				),
			)
			.returning({ id: sentimentDispatchPermits.id });
		if (!row) {
			const current = await tx.query.sentimentDispatchPermits.findFirst({
				where: eq(sentimentDispatchPermits.id, args.permitId),
			});
			return { revoked: false, state: current?.state ?? null };
		}
		await appendControlEvent(tx, {
			subjectKind: "permit",
			subjectKey: args.permitId,
			fromState: "live",
			toState: "revoked",
			...who,
		});
		return { revoked: true, state: "revoked" };
	});
}

/** A permit row plus whether it is effective right now by the database clock (stored state and eligibility stay distinguishable). */
export type ListedPermit = SentimentDispatchPermit & { effective: boolean };

/**
 * Permits newest first (identifiers, budgets, amounts, states — never prompts
 * or answers). `live` selects only permits in a live state whose expiry has
 * not passed by the database clock; a stale row that no mutating path has
 * transitioned yet is therefore never reported as live. Read-only.
 */
export async function listPermits(
	filter: { analysisId?: string; live?: boolean } = {},
	executor: Executor = db,
): Promise<ListedPermit[]> {
	const effective = and(
		inArray(sentimentDispatchPermits.state, [...PERMIT_LIVE_STATES]),
		sql`${sentimentDispatchPermits.expiresAt} > now()`,
	);
	const conditions = [
		filter.analysisId ? eq(sentimentDispatchPermits.analysisId, filter.analysisId) : undefined,
		filter.live ? effective : undefined,
	].filter((c): c is NonNullable<typeof c> => c !== undefined);
	const rows = await executor
		.select({ permit: sentimentDispatchPermits, effective: sql<boolean>`coalesce(${effective}, false)` })
		.from(sentimentDispatchPermits)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(sentimentDispatchPermits.issuedAt))
		.limit(200);
	return rows.map((r) => ({ ...r.permit, effective: r.effective }));
}

/** Events of one subject in sequence order. */
export async function listControlEvents(
	subjectKind: ControlSubjectKind,
	subjectKey: string,
	executor: Executor = db,
): Promise<SentimentControlEvent[]> {
	return executor
		.select()
		.from(sentimentControlEvents)
		.where(and(eq(sentimentControlEvents.subjectKind, subjectKind), eq(sentimentControlEvents.subjectKey, subjectKey)))
		.orderBy(sentimentControlEvents.seq);
}
