import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/db";
import { type SentimentProviderBreaker, sentimentProviderBreakers } from "../db/schema";
import { StructuredResearchRequestError, StructuredResearchResponseError } from "../providers/types";
import { appendControlEvent, type ControlActor, requireActor } from "./controls";
import type { SafeSentimentError } from "./errors";
import type { RequestProfile } from "./fingerprint";
import type { Executor } from "./store";

/**
 * Persisted circuit breaker per `rp1:` request-profile scope (Amendment C).
 * It observes the typed outcome of every sentiment request and blocks the
 * scope before the network when the provider — or the local strict-schema
 * guard — deterministically refused the request shape. An absent row is
 * `closed`; only the dispatch hold fails closed.
 */

export type DispatchFailureClass =
	/** Local strict-schema refusal: nothing left the process, nothing was charged. */
	| "local-contract"
	/** The provider refused the request itself before generation: structured error, no output, no charge. */
	| "request-refused-400"
	/** Timeouts, aborts, transport failures, non-structured or output-bearing refusals: the outcome is unknown. */
	| "response-lost"
	/** A paid answer the contract could not shape; an ordinary contract defect of the answer. */
	| "paid-answer-invalid"
	/** Rate limits, overload and other transient provider states. */
	| "retryable"
	/** Deterministic refusals of credentials, credit, permissions or the resource; the operator's, not the breaker's. */
	| "other-refusal";

export const BREAKER_OPENING_CLASSES: ReadonlySet<DispatchFailureClass> = new Set([
	"local-contract",
	"request-refused-400",
]);

/** Decided from typed error fields only — never from message text. */
export function classifyDispatchFailure(error: unknown, safe: SafeSentimentError): DispatchFailureClass {
	if (error instanceof Error && error.name === "StructuredOutputSchemaError") return "local-contract";
	if (safe.code === "schema-budget-exceeded" && !safe.requestSent) return "local-contract";
	if (error instanceof StructuredResearchResponseError) return "paid-answer-invalid";
	if (safe.kind === "validation" && safe.envelope?.generationId) return "paid-answer-invalid";
	if (error instanceof StructuredResearchRequestError) {
		if (!error.structured || error.carriesOutput) return "response-lost";
		if (error.httpStatus === 400) return "request-refused-400";
		if (error.httpStatus === 429 || error.httpStatus === 408 || error.httpStatus >= 500) return "retryable";
		return "other-refusal";
	}
	return "response-lost";
}

export const BREAKER_PROBE_LEASE_SECONDS = 900;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** Owner decision D6: 15 min × 2ⁿ⁻¹, capped at 6 h. */
export function breakerBackoffMs(consecutiveFailures: number): number {
	const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
	return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

export type BreakerDecision =
	| { allow: true; probe: boolean }
	| { allow: false; reason: "breaker-open" | "probe-in-progress"; until: Date | null };

/** What a request may do given the scope's row as read (the probe itself is granted by {@link acquireProbe}). */
export function decideBreaker(row: SentimentProviderBreaker | null, now: Date): BreakerDecision {
	if (!row || row.state === "closed") return { allow: true, probe: false };
	if (row.state === "open") {
		if (row.openUntil && row.openUntil.getTime() > now.getTime()) {
			return { allow: false, reason: "breaker-open", until: row.openUntil };
		}
		return { allow: true, probe: true };
	}
	// half_open
	if (row.probeAttemptId && row.probeLeaseUntil && row.probeLeaseUntil.getTime() > now.getTime()) {
		return { allow: false, reason: "probe-in-progress", until: row.probeLeaseUntil };
	}
	return { allow: true, probe: true };
}

export async function readBreaker(scopeKey: string, executor: Executor = db): Promise<SentimentProviderBreaker | null> {
	const row = await executor.query.sentimentProviderBreakers.findFirst({
		where: eq(sentimentProviderBreakers.scopeKey, scopeKey),
	});
	return row ?? null;
}

/** The database clock, so leases and expiries never depend on a worker's clock. */
export async function databaseNow(executor: Executor = db): Promise<Date> {
	const result = (await executor.execute(sql`select now() as now`)) as unknown as {
		rows?: { now: Date | string }[];
	};
	const row = (result.rows ?? (result as unknown as { now: Date | string }[]))[0];
	return new Date(row.now);
}

/**
 * Grant the single half-open probe to `attemptId` inside the caller's
 * transaction. One conditional UPDATE: an expired open row or a half-open row
 * without a live lease moves to `half_open` with this attempt as lease owner
 * and a bumped generation. Under Read Committed a concurrent updater blocks on
 * the row lock and re-evaluates this WHERE against the winner's row, so it
 * sees a live lease and gets zero rows.
 */
export async function acquireProbe(
	tx: Executor,
	scopeKey: string,
	attemptId: string,
): Promise<{ generation: number } | null> {
	const [row] = await tx
		.update(sentimentProviderBreakers)
		.set({
			state: "half_open",
			probeAttemptId: attemptId,
			probeGeneration: sql`${sentimentProviderBreakers.probeGeneration} + 1`,
			probeLeaseUntil: sql`now() + make_interval(secs => ${BREAKER_PROBE_LEASE_SECONDS})`,
			updatedAt: sql`now()`,
		})
		.where(
			and(
				eq(sentimentProviderBreakers.scopeKey, scopeKey),
				or(
					and(eq(sentimentProviderBreakers.state, "open"), sql`${sentimentProviderBreakers.openUntil} <= now()`),
					and(
						eq(sentimentProviderBreakers.state, "half_open"),
						or(
							isNull(sentimentProviderBreakers.probeAttemptId),
							sql`${sentimentProviderBreakers.probeLeaseUntil} < now()`,
						),
					),
				),
			),
		)
		.returning({ generation: sentimentProviderBreakers.probeGeneration });
	if (!row) return null;
	await appendControlEvent(tx, {
		subjectKind: "breaker",
		subjectKey: scopeKey,
		fromState: null,
		toState: "half_open",
		evidence: { probe: "acquired", attemptId, generation: row.generation },
		...SYSTEM_ACTOR,
	});
	return { generation: row.generation };
}

export interface BreakerOpenEvidence {
	scopeKey: string;
	profile: RequestProfile;
	schemaFp: string;
	failureClass: DispatchFailureClass;
	phase: string;
	attemptId: string | null;
	httpStatus: number | null;
	errorType: string | null;
	rule: string | null;
}

const SYSTEM_ACTOR: ControlActor = {
	actor: "system:dispatch-breaker",
	reason: "deterministic request refusal observed at the provider boundary",
	correlationId: "amendment-c",
};

/**
 * `open_until` for the strike that brings the row to `consecutive_failures`
 * (already incremented): 15 min × 2ⁿ⁻¹ capped at 6 h, computed in SQL from the
 * row's own value so the backoff always follows the committed count.
 */
const openUntilFromRow = sql`now() + least(make_interval(secs => ${BACKOFF_BASE_MS / 1000} * power(2, least(greatest(${sentimentProviderBreakers.consecutiveFailures} - 1, 0), 20))), make_interval(secs => ${BACKOFF_MAX_MS / 1000}))`;

/**
 * One strike against a scope row the caller has already locked: the count is
 * incremented relative to the row's current value and the backoff derives from
 * that result, so concurrent strikes serialize on the lock and none is lost.
 */
async function strikeLockedRow(
	tx: Executor,
	scopeKey: string,
	evidence: Pick<BreakerOpenEvidence, "failureClass" | "phase" | "attemptId" | "httpStatus" | "errorType" | "rule">,
	reason: string,
): Promise<number> {
	const [row] = await tx
		.update(sentimentProviderBreakers)
		.set({
			state: "open",
			openedAt: sql`now()`,
			consecutiveFailures: sql`${sentimentProviderBreakers.consecutiveFailures} + 1`,
			probeAttemptId: null,
			probeLeaseUntil: null,
			openedClass: evidence.failureClass,
			openedPhase: evidence.phase,
			lastAttemptId: evidence.attemptId,
			lastHttpStatus: evidence.httpStatus,
			lastErrorType: evidence.errorType,
			lastRule: evidence.rule,
			lastChangedBy: SYSTEM_ACTOR.actor,
			lastReason: reason,
			updatedAt: sql`now()`,
		})
		.where(eq(sentimentProviderBreakers.scopeKey, scopeKey))
		.returning({ consecutiveFailures: sentimentProviderBreakers.consecutiveFailures });
	// The backoff is a second statement so it reads the count the first one wrote to the row version.
	await tx
		.update(sentimentProviderBreakers)
		.set({ openUntil: openUntilFromRow })
		.where(eq(sentimentProviderBreakers.scopeKey, scopeKey));
	return row.consecutiveFailures;
}

/**
 * Open the scope on a deterministic refusal (one strike, owner decision D4).
 * The row is seeded `closed` when absent (`ON CONFLICT DO NOTHING`); the scope
 * and — for a local contract refusal, which is a property of the document —
 * every known sibling scope carrying the same `sfp1` schema are then locked in
 * one `SELECT … FOR UPDATE` in scope-key order and struck relative to their
 * committed values. Under Read Committed a concurrent striker blocks on the
 * row lock and, once it acquires it, sees the committed row version, so its
 * increment lands on top of the first strike (PostgreSQL docs, Transaction
 * Isolation → Read Committed). Every committed strike therefore raises
 * `consecutive_failures` by one and sets `open_until` from the resulting
 * count, with one audit event carrying that count.
 */
export async function openBreaker(tx: Executor, evidence: BreakerOpenEvidence): Promise<void> {
	await tx
		.insert(sentimentProviderBreakers)
		.values({
			scopeKey: evidence.scopeKey,
			provider: evidence.profile.adapter,
			model: evidence.profile.model,
			schemaFp: evidence.schemaFp,
			requestProfile: evidence.profile,
			state: "closed",
			consecutiveFailures: 0,
			lastChangedBy: SYSTEM_ACTOR.actor,
			lastReason: "scope row created on its first observed refusal",
		})
		.onConflictDoNothing({ target: sentimentProviderBreakers.scopeKey });
	const siblingKeys =
		evidence.failureClass === "local-contract"
			? (
					await tx
						.select({ scopeKey: sentimentProviderBreakers.scopeKey })
						.from(sentimentProviderBreakers)
						.where(
							and(
								eq(sentimentProviderBreakers.schemaFp, evidence.schemaFp),
								sql`${sentimentProviderBreakers.scopeKey} <> ${evidence.scopeKey}`,
								inArray(sentimentProviderBreakers.state, ["closed", "half_open"]),
							),
						)
				).map((r) => r.scopeKey)
			: [];
	const keys = [...new Set([evidence.scopeKey, ...siblingKeys])].sort();
	const locked = await tx
		.select({ scopeKey: sentimentProviderBreakers.scopeKey, state: sentimentProviderBreakers.state })
		.from(sentimentProviderBreakers)
		.where(inArray(sentimentProviderBreakers.scopeKey, keys))
		.orderBy(sentimentProviderBreakers.scopeKey)
		.for("update");
	for (const row of locked) {
		const sibling = row.scopeKey !== evidence.scopeKey;
		// A sibling that was struck open by someone else while we waited for its lock is not struck again here.
		if (sibling && row.state === "open") continue;
		const failures = await strikeLockedRow(
			tx,
			row.scopeKey,
			sibling ? { ...evidence, httpStatus: null, errorType: null } : evidence,
			sibling ? `sibling scope shares the refused schema shape ${evidence.schemaFp}` : SYSTEM_ACTOR.reason,
		);
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: row.scopeKey,
			fromState: row.state,
			toState: "open",
			evidence: sibling
				? {
						failureClass: evidence.failureClass,
						siblingOf: evidence.scopeKey,
						rule: evidence.rule,
						consecutiveFailures: failures,
					}
				: {
						failureClass: evidence.failureClass,
						phase: evidence.phase,
						attemptId: evidence.attemptId,
						httpStatus: evidence.httpStatus,
						errorType: evidence.errorType,
						rule: evidence.rule,
						consecutiveFailures: failures,
					},
			...SYSTEM_ACTOR,
		});
	}
}

/** How the probe request ended, as the breaker sees it. */
export type ProbeOutcome =
	/** The provider accepted the request (paid answer, accepted or rejected): the scope closes. */
	| "accepted"
	/** A deterministic refusal (class 1 or 2): the scope re-opens with a longer backoff. */
	| "refused"
	/** The request never left (boundary guard refused it): the lease is freed so the next request may probe. */
	| "released"
	/** Any other failure (transient, unknown): the lease stands until it expires; nothing is written. */
	| "untouched";

/**
 * The probe's outcome, fenced on the lease (attempt id and generation). A
 * lease taken over meanwhile makes every write a no-op (`fenced`).
 */
export async function settleProbe(
	tx: Executor,
	args: { scopeKey: string; attemptId: string; generation: number; outcome: ProbeOutcome },
): Promise<"closed" | "reopened" | "released" | "untouched" | "fenced"> {
	const fence = and(
		eq(sentimentProviderBreakers.scopeKey, args.scopeKey),
		eq(sentimentProviderBreakers.probeAttemptId, args.attemptId),
		eq(sentimentProviderBreakers.probeGeneration, args.generation),
	);
	if (args.outcome === "untouched") return "untouched";
	if (args.outcome === "accepted") {
		const [row] = await tx
			.update(sentimentProviderBreakers)
			.set({
				state: "closed",
				consecutiveFailures: 0,
				openUntil: null,
				probeAttemptId: null,
				probeLeaseUntil: null,
				lastAttemptId: args.attemptId,
				lastChangedBy: SYSTEM_ACTOR.actor,
				lastReason: "half-open probe accepted by the provider",
				updatedAt: sql`now()`,
			})
			.where(fence)
			.returning({ scopeKey: sentimentProviderBreakers.scopeKey });
		if (!row) return "fenced";
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: args.scopeKey,
			fromState: "half_open",
			toState: "closed",
			evidence: { attemptId: args.attemptId, generation: args.generation },
			...SYSTEM_ACTOR,
		});
		return "closed";
	}
	if (args.outcome === "released") {
		const [row] = await tx
			.update(sentimentProviderBreakers)
			.set({
				probeAttemptId: null,
				probeLeaseUntil: null,
				lastChangedBy: SYSTEM_ACTOR.actor,
				lastReason: "half-open probe released before any request left",
				updatedAt: sql`now()`,
			})
			.where(fence)
			.returning({ scopeKey: sentimentProviderBreakers.scopeKey });
		if (!row) return "fenced";
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: args.scopeKey,
			fromState: "half_open",
			toState: "half_open",
			evidence: { attemptId: args.attemptId, generation: args.generation, probe: "released" },
			...SYSTEM_ACTOR,
		});
		return "released";
	}
	const [row] = await tx
		.update(sentimentProviderBreakers)
		.set({
			state: "open",
			consecutiveFailures: sql`${sentimentProviderBreakers.consecutiveFailures} + 1`,
			openedAt: sql`now()`,
			probeAttemptId: null,
			probeLeaseUntil: null,
			lastAttemptId: args.attemptId,
			lastChangedBy: SYSTEM_ACTOR.actor,
			lastReason: "half-open probe refused deterministically",
			updatedAt: sql`now()`,
		})
		.where(fence)
		.returning({ consecutiveFailures: sentimentProviderBreakers.consecutiveFailures });
	if (!row) return "fenced";
	await tx
		.update(sentimentProviderBreakers)
		.set({ openUntil: openUntilFromRow })
		.where(eq(sentimentProviderBreakers.scopeKey, args.scopeKey));
	await appendControlEvent(tx, {
		subjectKind: "breaker",
		subjectKey: args.scopeKey,
		fromState: "half_open",
		toState: "open",
		evidence: { attemptId: args.attemptId, generation: args.generation, consecutiveFailures: row.consecutiveFailures },
		...SYSTEM_ACTOR,
	});
	return "reopened";
}

/**
 * Operator reset: an `open` scope becomes `half_open` with no lease so the
 * next request is the single probe. There is deliberately no path to
 * `closed` other than an accepted probe.
 */
export async function resetBreaker(
	args: { scopeKey: string } & ControlActor,
	executor: Executor = db,
): Promise<{ reset: boolean; state: string | null }> {
	const who = requireActor(args);
	return executor.transaction(async (tx) => {
		const [row] = await tx
			.update(sentimentProviderBreakers)
			.set({
				state: "half_open",
				probeAttemptId: null,
				probeLeaseUntil: null,
				openUntil: sql`now()`,
				lastChangedBy: who.actor,
				lastReason: who.reason,
				updatedAt: sql`now()`,
			})
			.where(and(eq(sentimentProviderBreakers.scopeKey, args.scopeKey), eq(sentimentProviderBreakers.state, "open")))
			.returning({ scopeKey: sentimentProviderBreakers.scopeKey });
		if (!row) {
			const current = await readBreaker(args.scopeKey, tx);
			return { reset: false, state: current?.state ?? null };
		}
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: args.scopeKey,
			fromState: "open",
			toState: "half_open",
			...who,
		});
		return { reset: true, state: "half_open" };
	});
}

/** Operator containment: open a known scope until a given time. */
export async function openBreakerManually(
	args: { scopeKey: string; untilSeconds: number } & ControlActor,
	executor: Executor = db,
): Promise<{ opened: boolean; state: string | null }> {
	const who = requireActor(args);
	if (!Number.isInteger(args.untilSeconds) || args.untilSeconds <= 0)
		throw new Error("until must be a positive integer of seconds");
	return executor.transaction(async (tx) => {
		const previous = await readBreaker(args.scopeKey, tx);
		if (!previous) return { opened: false, state: null };
		await tx
			.update(sentimentProviderBreakers)
			.set({
				state: "open",
				openedAt: sql`now()`,
				openUntil: sql`now() + make_interval(secs => ${args.untilSeconds})`,
				probeAttemptId: null,
				probeLeaseUntil: null,
				lastChangedBy: who.actor,
				lastReason: who.reason,
				updatedAt: sql`now()`,
			})
			.where(eq(sentimentProviderBreakers.scopeKey, args.scopeKey));
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: args.scopeKey,
			fromState: previous.state,
			toState: "open",
			evidence: { untilSeconds: args.untilSeconds },
			...who,
		});
		return { opened: true, state: "open" };
	});
}

export async function listBreakers(executor: Executor = db): Promise<SentimentProviderBreaker[]> {
	return executor.select().from(sentimentProviderBreakers).orderBy(sentimentProviderBreakers.updatedAt);
}

/** Scopes that block a request right now (for status output). */
export async function listBlockingBreakers(executor: Executor = db): Promise<SentimentProviderBreaker[]> {
	return executor
		.select()
		.from(sentimentProviderBreakers)
		.where(
			or(
				and(eq(sentimentProviderBreakers.state, "open"), sql`${sentimentProviderBreakers.openUntil} > now()`),
				and(
					eq(sentimentProviderBreakers.state, "half_open"),
					sql`${sentimentProviderBreakers.probeLeaseUntil} > now()`,
				),
			),
		);
}
