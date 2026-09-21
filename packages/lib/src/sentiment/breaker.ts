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
	return row ? { generation: row.generation } : null;
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
 * Open the scope on a deterministic refusal (one strike, owner decision D4):
 * upsert the row as `open`, count the failure, set `open_until` by the
 * backoff, clear any probe lease and record the evidence. A local contract
 * refusal is a property of the document, so every known sibling scope that
 * carries the same `sfp1` schema is opened too.
 */
export async function openBreaker(tx: Executor, evidence: BreakerOpenEvidence): Promise<void> {
	const base = {
		provider: evidence.profile.adapter,
		model: evidence.profile.model,
		schemaFp: evidence.schemaFp,
		requestProfile: evidence.profile,
		state: "open" as const,
		openedAt: sql`now()`,
		consecutiveFailures: 1,
		openUntil: sql`now() + make_interval(secs => ${Math.round(breakerBackoffMs(1) / 1000)})`,
		probeAttemptId: null,
		probeLeaseUntil: null,
		openedClass: evidence.failureClass,
		openedPhase: evidence.phase,
		lastAttemptId: evidence.attemptId,
		lastHttpStatus: evidence.httpStatus,
		lastErrorType: evidence.errorType,
		lastRule: evidence.rule,
		lastChangedBy: SYSTEM_ACTOR.actor,
		lastReason: SYSTEM_ACTOR.reason,
		updatedAt: sql`now()`,
	};
	const previous = await readBreaker(evidence.scopeKey, tx);
	const failures = (previous?.consecutiveFailures ?? 0) + 1;
	const [row] = await tx
		.insert(sentimentProviderBreakers)
		.values({ scopeKey: evidence.scopeKey, ...base })
		.onConflictDoUpdate({
			target: sentimentProviderBreakers.scopeKey,
			set: {
				...base,
				consecutiveFailures: failures,
				openUntil: sql`now() + make_interval(secs => ${Math.round(breakerBackoffMs(failures) / 1000)})`,
			},
		})
		.returning({ consecutiveFailures: sentimentProviderBreakers.consecutiveFailures });
	await appendControlEvent(tx, {
		subjectKind: "breaker",
		subjectKey: evidence.scopeKey,
		fromState: previous?.state ?? null,
		toState: "open",
		evidence: {
			failureClass: evidence.failureClass,
			phase: evidence.phase,
			attemptId: evidence.attemptId,
			httpStatus: evidence.httpStatus,
			errorType: evidence.errorType,
			rule: evidence.rule,
			consecutiveFailures: row.consecutiveFailures,
		},
		...SYSTEM_ACTOR,
	});
	if (evidence.failureClass !== "local-contract") return;
	const siblings = await tx
		.select({ scopeKey: sentimentProviderBreakers.scopeKey, state: sentimentProviderBreakers.state })
		.from(sentimentProviderBreakers)
		.where(
			and(
				eq(sentimentProviderBreakers.schemaFp, evidence.schemaFp),
				sql`${sentimentProviderBreakers.scopeKey} <> ${evidence.scopeKey}`,
				inArray(sentimentProviderBreakers.state, ["closed", "half_open"]),
			),
		);
	for (const sibling of siblings) {
		await tx
			.update(sentimentProviderBreakers)
			.set({
				state: "open",
				openedAt: sql`now()`,
				openUntil: sql`now() + make_interval(secs => ${Math.round(breakerBackoffMs(1) / 1000)})`,
				consecutiveFailures: sql`${sentimentProviderBreakers.consecutiveFailures} + 1`,
				probeAttemptId: null,
				probeLeaseUntil: null,
				openedClass: evidence.failureClass,
				openedPhase: evidence.phase,
				lastAttemptId: evidence.attemptId,
				lastRule: evidence.rule,
				lastChangedBy: SYSTEM_ACTOR.actor,
				lastReason: `sibling scope shares the refused schema shape ${evidence.schemaFp}`,
				updatedAt: sql`now()`,
			})
			.where(eq(sentimentProviderBreakers.scopeKey, sibling.scopeKey));
		await appendControlEvent(tx, {
			subjectKind: "breaker",
			subjectKey: sibling.scopeKey,
			fromState: sibling.state,
			toState: "open",
			evidence: { failureClass: evidence.failureClass, siblingOf: evidence.scopeKey, rule: evidence.rule },
			...SYSTEM_ACTOR,
		});
	}
}

/**
 * The probe's outcome, fenced on the lease (attempt id and generation): a
 * request the provider accepted closes the scope; a deterministic refusal
 * re-opens it with a longer backoff. A lease taken over meanwhile makes both
 * writes no-ops.
 */
export async function settleProbe(
	tx: Executor,
	args: {
		scopeKey: string;
		attemptId: string;
		generation: number;
		accepted: boolean;
		failureClass?: DispatchFailureClass;
	},
): Promise<"closed" | "reopened" | "fenced"> {
	const fence = and(
		eq(sentimentProviderBreakers.scopeKey, args.scopeKey),
		eq(sentimentProviderBreakers.probeAttemptId, args.attemptId),
		eq(sentimentProviderBreakers.probeGeneration, args.generation),
	);
	if (args.accepted) {
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
	const previous = await readBreaker(args.scopeKey, tx);
	const failures = (previous?.consecutiveFailures ?? 0) + 1;
	const [row] = await tx
		.update(sentimentProviderBreakers)
		.set({
			state: "open",
			consecutiveFailures: failures,
			openedAt: sql`now()`,
			openUntil: sql`now() + make_interval(secs => ${Math.round(breakerBackoffMs(failures) / 1000)})`,
			probeAttemptId: null,
			probeLeaseUntil: null,
			openedClass: args.failureClass ?? null,
			lastAttemptId: args.attemptId,
			lastChangedBy: SYSTEM_ACTOR.actor,
			lastReason: "half-open probe refused deterministically",
			updatedAt: sql`now()`,
		})
		.where(fence)
		.returning({ scopeKey: sentimentProviderBreakers.scopeKey });
	if (!row) return "fenced";
	await appendControlEvent(tx, {
		subjectKind: "breaker",
		subjectKey: args.scopeKey,
		fromState: "half_open",
		toState: "open",
		evidence: { attemptId: args.attemptId, generation: args.generation, consecutiveFailures: failures },
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
