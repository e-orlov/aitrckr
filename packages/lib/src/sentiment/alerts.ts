import { createHash } from "node:crypto";
import { eq, type SQL, sql } from "drizzle-orm";
import { db } from "../db/db";
import { type SentimentAlertState, sentimentAlertState } from "../db/schema";
import {
	ALERT_SIGNALS,
	type AlertSeverity,
	type AlertSignalDefinition,
	AWAITING_REVIEW_EXACT_ID_LIMIT,
	AWAITING_REVIEW_FALLBACK_SCOPE,
	alertDefinition,
	alertRowKey,
	EVALUATOR_SIGNALS,
	MAINTENANCE_HEARTBEAT_KEY,
	parseAlertRowKey,
} from "./alert-registry";
import { databaseNow } from "./breaker";
import {
	appendControlEvent,
	type ControlActor,
	isHeld,
	PERMIT_PHASES,
	type PermitPhase,
	RESERVATION_ESTIMATES_USD,
	readDispatchState,
	requireActor,
} from "./controls";
import { listHeldWork } from "./held-release";
import type { Executor } from "./store";

/**
 * Deterministic alert evaluation over the dispatch-control rows (Amendment D).
 * Every window, age, cooldown and timestamp is the database clock; every
 * decision is a pure function of observed rows and the durable state row, so
 * a restart changes nothing. Persisted evidence is identifiers, counts,
 * bounded sanitized classifications, thresholds and runbook ids — never a
 * prompt, answer, candidate, schema document or credential. Alerting never
 * transitions dispatch, a breaker or a permit (D3).
 */

const EVIDENCE_ID_CAP = 20;
const HOUR_SECONDS = 3600;
const HELD_BACKLOG_COUNT_THRESHOLD = 20;
const HELD_BACKLOG_OLDEST_SECONDS = 48 * HOUR_SECONDS;
const AWAITING_REVIEW_ABSOLUTE_THRESHOLD = 5;
const AWAITING_REVIEW_RELATIVE_FRACTION = 0.25;
const REFUSALS_ACROSS_SHAPES_MIN_SCOPES = 2;
const CONFIG_REFUSAL_STATUSES = [401, 402, 403] as const;
/** Signals whose notification re-arms as soon as the blocking evidence changes materially, cooldown notwithstanding. */
const REARM_ON_CHANGE: ReadonlySet<string> = new Set(["reserve-exceeded", "permit-exhausted", "gate-breach"]);

export const RESERVATION_ESTIMATE_NOTE =
	"reservations are planning estimates, not hard provider-price ceilings; the enforceable limits are the phase budget, token/tool limits, expiry and fencing";

export interface AlertAck {
	digest: string;
	actor: string;
	correlationId: string;
	/** Database clock at acknowledgement. */
	at: string;
}

/** The durable, bounded watermark of one state row. */
export interface AlertWatermark {
	v: 1;
	observedDigest: string | null;
	firing: boolean;
	reason: string | null;
	lastNotifiedDigest: string | null;
	ack: AlertAck | null;
	/** Severity as evaluated (permit-exhausted escalates to urgent for an unverified canary). */
	severity?: AlertSeverity;
	/** Exact-mode growth signals: ids acknowledged so far and the ids observed as new at the last evaluation. */
	ackedIds?: string[];
	newIds?: string[];
	/** Count-delta mode (Q4). */
	mode?: "exact" | "count-delta";
	baselineCount?: number;
	watermarkCount?: number;
	precisionDegraded?: boolean;
}

export interface AlertObservation {
	signal: string;
	scope: string | null;
	rowKey: string;
	severity: AlertSeverity;
	firing: boolean;
	reason: string | null;
	observed: number;
	threshold: string;
	window: string | null;
	runbook: string;
	/** Stable identity of the firing evidence; equal digests mean the same unchanged state. */
	digest: string;
	evidence: Record<string, unknown>;
	approximate: boolean;
	/** Signal-specific durable fields merged into the watermark. */
	watermark?: Partial<AlertWatermark>;
}

export interface SentimentAlertRecord {
	v: 1;
	kind: "sentiment-alert";
	signal: string;
	scope: string | null;
	rowKey: string;
	severity: AlertSeverity;
	reason: string | null;
	observed: number;
	threshold: string;
	window: string | null;
	runbook: string;
	digest: string;
	evidence: Record<string, unknown>;
	approximate: boolean;
	evaluatedAt: string;
	alertedAt: string;
	cooldownUntil: string;
	note?: string;
}

export type AlertSink = (record: SentimentAlertRecord) => void | Promise<void>;

/** Stable grouping identity for an external sink: the signal and its scope, never the digest, evidence or time. */
export function sentimentAlertFingerprint(record: Pick<SentimentAlertRecord, "signal" | "scope">): string[] {
	return ["sentiment-alert", record.signal, record.scope ?? "global"];
}

/** Approved severity policy for an external sink: urgent pages (error), informational is a ticket (info). */
export function sentimentAlertLevel(severity: AlertSeverity): "error" | "info" {
	return severity === "urgent" ? "error" : "info";
}

const RECORD_KEYS = [
	"v",
	"kind",
	"signal",
	"scope",
	"rowKey",
	"severity",
	"reason",
	"observed",
	"threshold",
	"window",
	"runbook",
	"digest",
	"evidence",
	"approximate",
	"evaluatedAt",
	"alertedAt",
	"cooldownUntil",
	"note",
] as const;
const FORBIDDEN_EVIDENCE_KEYS =
	/prompt|answer|candidate|schema|apiKey|api_key|authorization|token|secret|password|body/i;

/**
 * A record is emittable only if it carries exactly the contract keys and its
 * evidence names nothing that could hold a prompt, an answer, a candidate, a
 * schema document or a credential. Thrown, never logged, on violation.
 */
export function assertEmittableAlertRecord(record: SentimentAlertRecord): void {
	for (const key of Object.keys(record)) {
		if (!(RECORD_KEYS as readonly string[]).includes(key))
			throw new Error(`alert record carries an unknown key "${key}"`);
	}
	const walk = (value: unknown, path: string): void => {
		if (value === null || typeof value !== "object") return;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_EVIDENCE_KEYS.test(k)) throw new Error(`alert evidence must not carry "${path}${k}"`);
			if (typeof v === "string" && v.length > 512) throw new Error(`alert evidence value "${path}${k}" is not bounded`);
			walk(v, `${path}${k}.`);
		}
	};
	walk(record.evidence, "evidence.");
}

export const logAlertSink: AlertSink = (record) => {
	console.warn(`[sentiment-alert] ${JSON.stringify(record)}`);
};

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const digestOfIds = (ids: readonly string[]): string => sha256Hex([...ids].sort().join("\n"));
const capIds = (ids: readonly string[]): string[] => [...ids].sort().slice(0, EVIDENCE_ID_CAP);

// ---------------------------------------------------------------------------
// Pure decisions (unit-tested table by table)
// ---------------------------------------------------------------------------

/** D9: absolute threshold always; the relative one only when the baseline is greater than zero. */
export function awaitingReviewThreshold(baselineCount: number): number {
	if (baselineCount <= 0) return AWAITING_REVIEW_ABSOLUTE_THRESHOLD;
	return Math.min(AWAITING_REVIEW_ABSOLUTE_THRESHOLD, Math.ceil(AWAITING_REVIEW_RELATIVE_FRACTION * baselineCount));
}

export function decideAwaitingReviewGrowth(args: { newCount: number; baselineCount: number }): {
	firing: boolean;
	threshold: number;
} {
	const threshold = awaitingReviewThreshold(args.baselineCount);
	return { firing: args.newCount >= threshold, threshold };
}

export function decideHeldBacklogGrowth(args: { count: number; oldestAgeSeconds: number | null }): {
	firing: boolean;
	reason: "count" | "age" | null;
} {
	if (args.count >= HELD_BACKLOG_COUNT_THRESHOLD) return { firing: true, reason: "count" };
	if (args.oldestAgeSeconds !== null && args.oldestAgeSeconds >= HELD_BACKLOG_OLDEST_SECONDS)
		return { firing: true, reason: "age" };
	return { firing: false, reason: null };
}

export function decideRefusalsAcrossShapes(distinctScopes: number): boolean {
	return distinctScopes >= REFUSALS_ACROSS_SHAPES_MIN_SCOPES;
}

export interface PermitSnapshot {
	id: string;
	purpose: string;
	state: string;
	phaseBudget: Record<string, number>;
	estimatedCostBudgetUsd: number;
	settledCostUsd: number;
	reservedEstimateUsd: number;
	/** `expires_at <= now()` by the database clock. */
	expired: boolean;
	/** The lifecycle still expects automatic work: analysis unresolved and the case in an automatic status. */
	lifecycleAutomatic: boolean;
	verified: boolean;
	caseStatus: string | null;
}

export type PermitExhaustedReason = "phase-budget-exhausted" | "active-expired-unresolved";

/**
 * Q2: a stranded lifecycle — the permit was consumed or became unusable before
 * verified completion. Never an unused expired `issued` permit, never a
 * revoked one, never a lifecycle already parked for review or reconciliation
 * (those populations have their own signals), never a reservation refusal
 * (that is `reserve-exceeded`).
 */
export function decidePermitExhausted(p: PermitSnapshot): PermitExhaustedReason | null {
	if (p.verified || !p.lifecycleAutomatic) return null;
	if (p.state === "revoked" || p.state === "expired") return null;
	const budgets = PERMIT_PHASES.map((phase) => p.phaseBudget[phase] ?? 0);
	if (p.state === "exhausted" || budgets.every((b) => b === 0)) return "phase-budget-exhausted";
	if (p.state === "active" && p.expired) return "active-expired-unresolved";
	return null;
}

/** The phases whose budget is 1 but whose planning reservation the live permit can no longer cover. */
export function reserveBlockedPhases(p: PermitSnapshot): PermitPhase[] {
	if (p.expired || (p.state !== "issued" && p.state !== "active")) return [];
	if (!p.lifecycleAutomatic || p.verified) return [];
	return PERMIT_PHASES.filter(
		(phase) =>
			(p.phaseBudget[phase] ?? 0) === 1 &&
			p.settledCostUsd + p.reservedEstimateUsd + RESERVATION_ESTIMATES_USD[phase] > p.estimatedCostBudgetUsd + 1e-9,
	);
}

export interface NotificationDecision {
	notify: boolean;
	active: boolean;
	cooling: boolean;
	suppressedBy: "not-firing" | "acknowledged" | "cooldown" | "unchanged" | null;
}

/**
 * Whether a firing observation notifies now. Acknowledged evidence never
 * notifies again until it changes; an unchanged state notifies at most once
 * per cooldown; a materially changed state re-arms immediately only for the
 * signals that dedupe by state (permit-bound and per-occurrence signals).
 */
export function decideNotification(args: {
	signal: string;
	firing: boolean;
	digest: string;
	previous: AlertWatermark | null;
	cooldownUntil: Date | null;
	now: Date;
}): NotificationDecision {
	const cooling = args.cooldownUntil !== null && args.cooldownUntil.getTime() > args.now.getTime();
	if (!args.firing) return { notify: false, active: false, cooling, suppressedBy: "not-firing" };
	const acked = args.previous?.ack?.digest === args.digest;
	if (acked) return { notify: false, active: false, cooling, suppressedBy: "acknowledged" };
	const changed = args.previous?.lastNotifiedDigest !== args.digest;
	if (!cooling) return { notify: true, active: true, cooling, suppressedBy: null };
	if (changed && REARM_ON_CHANGE.has(args.signal)) return { notify: true, active: true, cooling, suppressedBy: null };
	return { notify: false, active: true, cooling, suppressedBy: changed ? "cooldown" : "unchanged" };
}

// ---------------------------------------------------------------------------
// Observers (real rows → observations)
// ---------------------------------------------------------------------------

type Rows<T> = { rows: T[] };
const execute = <T>(executor: Executor, query: SQL) => executor.execute(query) as unknown as Promise<Rows<T>>;

interface Baseline {
	mode: "exact" | "count-delta";
	ids?: string[];
	count: number;
	capturedAt: string;
	precisionDegraded?: boolean;
}

async function loadState(executor: Executor, rowKey: string): Promise<SentimentAlertState | null> {
	const row = await executor.query.sentimentAlertState.findFirst({ where: eq(sentimentAlertState.signal, rowKey) });
	return row ?? null;
}

const watermarkOf = (row: SentimentAlertState | null): AlertWatermark | null =>
	row?.watermark && typeof row.watermark === "object" ? (row.watermark as AlertWatermark) : null;
const baselineOf = (row: SentimentAlertState | null): Baseline | null =>
	row?.baseline && typeof row.baseline === "object" ? (row.baseline as Baseline) : null;

/**
 * R9 capture: on a maintenance tick under HELD, derive the baseline id sets in
 * one snapshot and insert them only where no baseline exists yet. Concurrent
 * first ticks converge: the insert or the `baseline IS NULL` update commits
 * for exactly one of them, and under HELD both read the same population.
 */
export async function captureAlertBaselines(
	executor: Executor = db,
): Promise<{ captured: string[]; present: string[] }> {
	const captured: string[] = [];
	const present: string[] = [];
	await executor.transaction(async (tx) => {
		const now = await databaseNow(tx);
		const targets: { rowKey: string; where: SQL }[] = [
			{ rowKey: "awaiting-review-growth", where: sql`status = 'awaiting_review'` },
			{
				rowKey: "first-contract-defect",
				where: sql`status = 'awaiting_review' and review_reason = 'contract-defect'`,
			},
		];
		for (const target of targets) {
			const { rows } = await execute<{ id: string }>(
				tx,
				sql`select analysis_id::text as id from sentiment_resolution_cases where ${target.where} order by analysis_id`,
			);
			const ids = rows.map((r) => r.id);
			const baseline: Baseline =
				ids.length > AWAITING_REVIEW_EXACT_ID_LIMIT
					? { mode: "count-delta", count: ids.length, capturedAt: now.toISOString(), precisionDegraded: true }
					: { mode: "exact", ids, count: ids.length, capturedAt: now.toISOString() };
			const { rows: written } = await execute<{ signal: string }>(
				tx,
				sql`insert into sentiment_alert_state (signal, baseline, updated_by, correlation_id, updated_at)
					values (${target.rowKey}, ${JSON.stringify(baseline)}::jsonb, 'system:alert-evaluator', 'amendment-d', now())
					on conflict (signal) do update set baseline = excluded.baseline, updated_at = now()
					where sentiment_alert_state.baseline is null
					returning signal`,
			);
			if (written.length > 0) {
				captured.push(target.rowKey);
				await appendControlEvent(tx, {
					subjectKind: "alert",
					subjectKey: target.rowKey,
					fromState: null,
					toState: "baseline-captured",
					evidence: {
						mode: baseline.mode,
						count: baseline.count,
						precisionDegraded: baseline.precisionDegraded ?? false,
					},
					actor: "system:alert-evaluator",
					reason: "alert baseline derived from the existing rows under a held dispatch",
					correlationId: "amendment-d",
				});
			} else present.push(target.rowKey);
		}
	});
	return { captured, present };
}

interface GrowthInput {
	rowKey: "awaiting-review-growth" | "first-contract-defect";
	definition: AlertSignalDefinition;
	currentIds: string[];
	currentCount: number;
	countsByReason: Record<string, number>;
	oldestAgeSeconds: number | null;
	baseline: Baseline;
	previous: AlertWatermark | null;
	held: boolean;
}

const growthThreshold = (relative: boolean, threshold: number, baselineCount: number, approximate: boolean): string =>
	relative
		? `>= ${threshold} new (absolute ${AWAITING_REVIEW_ABSOLUTE_THRESHOLD}${baselineCount > 0 ? `, relative ceil(0.25 x ${baselineCount})` : ""})${approximate ? " [approximate]" : ""}`
		: `>= 1 new${approximate ? " [approximate]" : ""}`;

const growthWindow = (definition: AlertSignalDefinition): string | null =>
	definition.windowSeconds === null ? null : `${definition.windowSeconds}s`;

/** Q4 count-delta precision: no id set is persisted; thresholds apply to the count delta and every field says so. */
function observeGrowthDegraded(input: GrowthInput, relative: boolean): AlertObservation {
	const { definition, baseline, previous } = input;
	const baselineCount = previous?.baselineCount ?? baseline.count;
	const carriedAcks = previous?.mode === "count-delta" ? 0 : (previous?.ackedIds?.length ?? 0);
	const watermarkCount = Math.max(previous?.watermarkCount ?? 0, baselineCount + carriedAcks);
	const delta = Math.max(0, input.currentCount - Math.max(baselineCount, watermarkCount));
	const decision = relative
		? decideAwaitingReviewGrowth({ newCount: delta, baselineCount })
		: { firing: delta >= 1, threshold: 1 };
	return {
		signal: definition.signal,
		scope: null,
		rowKey: input.rowKey,
		severity: definition.severity,
		firing: decision.firing,
		reason: decision.firing ? "count-delta" : null,
		observed: delta,
		threshold: growthThreshold(relative, decision.threshold, baselineCount, true),
		window: growthWindow(definition),
		runbook: definition.runbook,
		digest: `count-delta:${input.currentCount}`,
		approximate: true,
		evidence: {
			mode: "count-delta",
			precisionDegraded: true,
			approximate: true,
			currentCount: input.currentCount,
			baselineCount,
			watermarkCount,
			delta,
			countsByReason: input.countsByReason,
			oldestAgeSeconds: input.oldestAgeSeconds,
		},
		watermark: {
			mode: "count-delta",
			baselineCount,
			watermarkCount,
			precisionDegraded: true,
			ackedIds: undefined,
			newIds: undefined,
		},
	};
}

/** Exact set arithmetic (R9): new = current − baseline − acknowledged, clock-free. */
function observeGrowthExact(input: GrowthInput, relative: boolean): AlertObservation {
	const { definition, baseline, previous } = input;
	const baselineIds = new Set(baseline.ids ?? []);
	const acked = new Set(previous?.ackedIds ?? []);
	const newIds = input.currentIds.filter((id) => !baselineIds.has(id) && !acked.has(id)).sort();
	const decision = relative
		? decideAwaitingReviewGrowth({ newCount: newIds.length, baselineCount: baseline.count })
		: { firing: newIds.length >= 1, threshold: 1 };
	const reason = relative ? "new-unacknowledged-cases" : "new-contract-defect";
	return {
		signal: definition.signal,
		scope: null,
		rowKey: input.rowKey,
		severity: definition.severity,
		firing: decision.firing,
		reason: decision.firing ? reason : null,
		observed: newIds.length,
		threshold: growthThreshold(relative, decision.threshold, baseline.count, false),
		window: growthWindow(definition),
		runbook: definition.runbook,
		digest: digestOfIds(newIds),
		approximate: false,
		evidence: {
			mode: "exact",
			newCount: newIds.length,
			newIds: capIds(newIds),
			baselineCount: baseline.count,
			ackedCount: acked.size,
			currentCount: input.currentCount,
			countsByReason: input.countsByReason,
			oldestAgeSeconds: input.oldestAgeSeconds,
			held: input.held,
		},
		watermark: { mode: "exact", newIds, ackedIds: [...acked].sort(), precisionDegraded: false },
	};
}

/** Exact-mode set arithmetic, or the Q4 count-delta degradation when the open population exceeds the id limit. */
function observeGrowth(input: GrowthInput): { observation: AlertObservation; fallbackEntered: boolean } {
	const relative = input.definition.signal === "awaiting-review-growth";
	const degraded =
		input.currentCount > AWAITING_REVIEW_EXACT_ID_LIMIT ||
		input.baseline.mode === "count-delta" ||
		input.previous?.mode === "count-delta";
	if (!degraded) return { observation: observeGrowthExact(input, relative), fallbackEntered: false };
	return {
		observation: observeGrowthDegraded(input, relative),
		fallbackEntered: input.previous?.mode !== "count-delta",
	};
}

async function observeCases(
	executor: Executor,
	where: SQL,
): Promise<{ ids: string[]; count: number; countsByReason: Record<string, number>; oldestAgeSeconds: number | null }> {
	const { rows } = await execute<{ id: string; review_reason: string | null; age_seconds: string }>(
		executor,
		sql`select analysis_id::text as id, review_reason, extract(epoch from now() - created_at)::text as age_seconds
			from sentiment_resolution_cases where ${where} order by analysis_id`,
	);
	const countsByReason: Record<string, number> = {};
	let oldest: number | null = null;
	for (const row of rows) {
		const key = row.review_reason ?? "none";
		countsByReason[key] = (countsByReason[key] ?? 0) + 1;
		const age = Math.floor(Number(row.age_seconds));
		if (oldest === null || age > oldest) oldest = age;
	}
	return { ids: rows.map((r) => r.id), count: rows.length, countsByReason, oldestAgeSeconds: oldest };
}

interface BreakerRow {
	scope_key: string;
	state: string;
	opened_at: string | null;
	open_until: string | null;
	consecutive_failures: number;
	probe_attempt_id: string | null;
	probe_generation: number;
	lease_expired: boolean;
	opened_class: string | null;
	opened_phase: string | null;
	last_attempt_id: string | null;
	last_http_status: number | null;
	last_error_type: string | null;
	last_rule: string | null;
	refusal_seq: number | null;
}

function breakerOpenObservation(b: BreakerRow): AlertObservation {
	const open = alertDefinition("breaker-open");
	const isOpen = b.state === "open";
	return {
		signal: open.signal,
		scope: b.scope_key,
		rowKey: alertRowKey(open.signal, b.scope_key),
		severity: open.severity,
		firing: isOpen,
		reason: isOpen ? (b.opened_class ?? "open") : null,
		observed: isOpen ? 1 : 0,
		threshold: "state = open",
		window: null,
		runbook: open.runbook,
		digest: isOpen ? `open:${b.opened_at}:${b.consecutive_failures}` : "closed",
		approximate: false,
		evidence: {
			scopeKey: b.scope_key,
			state: b.state,
			openedClass: b.opened_class,
			openedPhase: b.opened_phase,
			consecutiveFailures: b.consecutive_failures,
			openUntil: b.open_until,
			lastAttemptId: b.last_attempt_id,
			lastHttpStatus: b.last_http_status,
			lastErrorType: b.last_error_type,
			lastRule: b.last_rule,
		},
	};
}

function probeObservation(b: BreakerRow): AlertObservation {
	const probe = alertDefinition("probe-failed-or-expired");
	const refused = b.refusal_seq !== null && Number(b.refusal_seq) >= 1;
	const firing = b.lease_expired || refused;
	const reason = b.lease_expired ? "probe-lease-expired" : refused ? "probe-refused" : null;
	const digest = b.lease_expired
		? `lease-expired:${b.probe_attempt_id}:${b.probe_generation}`
		: refused
			? `refused:${b.refusal_seq}`
			: "none";
	return {
		signal: probe.signal,
		scope: b.scope_key,
		rowKey: alertRowKey(probe.signal, b.scope_key),
		severity: probe.severity,
		firing,
		reason,
		observed: firing ? 1 : 0,
		threshold: "probe refused (class 1/2) or lease passed without outcome",
		window: null,
		runbook: probe.runbook,
		digest,
		approximate: false,
		evidence: {
			scopeKey: b.scope_key,
			state: b.state,
			probeAttemptId: b.probe_attempt_id,
			probeGeneration: b.probe_generation,
			refusalEventSeq: b.refusal_seq,
			reason,
		},
	};
}

async function observeBreakers(executor: Executor): Promise<AlertObservation[]> {
	const { rows } = await execute<BreakerRow>(
		executor,
		sql`select b.scope_key, b.state, b.opened_at::text, b.open_until::text, b.consecutive_failures,
				b.probe_attempt_id::text, b.probe_generation,
				(b.state = 'half_open' and b.probe_lease_until is not null and b.probe_lease_until <= now()) as lease_expired,
				b.opened_class, b.opened_phase, b.last_attempt_id::text, b.last_http_status, b.last_error_type, b.last_rule,
				(select max(e.seq) from sentiment_control_events e
					where e.subject_kind = 'breaker' and e.subject_key = b.scope_key
					and e.from_state = 'half_open' and e.to_state = 'open') as refusal_seq
			from sentiment_provider_breakers b order by b.scope_key`,
	);
	return rows.flatMap((b) => [breakerOpenObservation(b), probeObservation(b)]);
}

async function observeRefusalsAcrossShapes(executor: Executor): Promise<AlertObservation> {
	const def = alertDefinition("refusals-across-shapes");
	const { rows } = await execute<{ scope_key: string; phases: string[]; strikes: number }>(
		executor,
		sql`select subject_key as scope_key,
				array_agg(distinct coalesce(evidence->>'phase', 'unknown')) as phases, count(*)::int as strikes
			from sentiment_control_events
			where subject_kind = 'breaker' and to_state = 'open'
				and evidence->>'failureClass' = 'request-refused-400' and evidence->>'siblingOf' is null
				and created_at > now() - make_interval(secs => ${def.windowSeconds ?? 0})
			group by subject_key order by subject_key`,
	);
	const scopes = rows.map((r) => r.scope_key);
	const firing = decideRefusalsAcrossShapes(scopes.length);
	return {
		signal: def.signal,
		scope: null,
		rowKey: def.signal,
		severity: def.severity,
		firing,
		reason: firing ? "class-2-refusals-across-scopes" : null,
		observed: scopes.length,
		threshold: `>= ${REFUSALS_ACROSS_SHAPES_MIN_SCOPES} distinct request-profile scopes`,
		window: `${def.windowSeconds}s`,
		runbook: def.runbook,
		digest: digestOfIds(scopes),
		approximate: false,
		evidence: {
			scopes: scopes.slice(0, EVIDENCE_ID_CAP),
			phases: [...new Set(rows.flatMap((r) => r.phases))].sort(),
			strikes: rows.reduce((n, r) => n + Number(r.strikes), 0),
		},
	};
}

async function observeProviderRefusals(executor: Executor): Promise<AlertObservation[]> {
	const def = alertDefinition("provider-refusal-config");
	// The status lives only in the sanitized analysis message ("… HTTP 401"); provider and model come from the
	// attempt ledger, never from message text. No body, header or credential is ever stored or read here.
	const { rows } = await execute<{
		provider: string;
		model: string;
		http_status: number;
		attempt_ids: string[];
		analysis_ids: string[];
	}>(
		executor,
		sql`with latest as (
				select distinct on (p.analysis_id) p.analysis_id, p.id as attempt_id, p.provider, p.model
				from sentiment_provider_attempts p
				where p.outcome = 'provider-error' and p.started_at > now() - make_interval(secs => ${def.windowSeconds ?? 0})
				order by p.analysis_id, p.ordinal desc)
			select l.provider, l.model,
				(regexp_match(a.error_message, ' HTTP (401|402|403)(\\D|$)'))[1]::int as http_status,
				array_agg(l.attempt_id::text order by l.attempt_id) as attempt_ids,
				array_agg(a.id::text order by a.id) as analysis_ids
			from latest l join sentiment_analyses a on a.id = l.analysis_id
			where a.status = 'pending_resolution' and a.error_code = 'provider'
				and a.error_message ~ ' HTTP (401|402|403)(\\D|$)'
			group by l.provider, l.model, http_status order by l.provider, l.model, http_status`,
	);
	return rows
		.filter((r) => (CONFIG_REFUSAL_STATUSES as readonly number[]).includes(Number(r.http_status)))
		.map((r) => {
			const scope = `${r.provider}:${r.model}:${r.http_status}`;
			return {
				signal: def.signal,
				scope,
				rowKey: alertRowKey(def.signal, scope),
				severity: def.severity,
				firing: r.attempt_ids.length > 0,
				reason: `http-${r.http_status}`,
				observed: r.attempt_ids.length,
				threshold: ">= 1 refused request",
				window: `${def.windowSeconds}s`,
				runbook: def.runbook,
				digest: digestOfIds(r.attempt_ids),
				approximate: false,
				evidence: {
					provider: r.provider,
					model: r.model,
					httpStatus: Number(r.http_status),
					attemptIds: capIds(r.attempt_ids),
					analysisIds: capIds(r.analysis_ids),
					count: r.attempt_ids.length,
				},
			};
		});
}

async function observeHeldBacklog(executor: Executor, held: boolean, epoch: number | null): Promise<AlertObservation> {
	const def = alertDefinition("held-backlog-growth");
	const work = await listHeldWork(0, executor);
	const count = work.counts.a + work.counts.b;
	const oldestAgeSeconds =
		work.oldestAt === null
			? null
			: Math.max(0, Math.floor(((await databaseNow(executor)).getTime() - work.oldestAt.getTime()) / 1000));
	const decision = held ? decideHeldBacklogGrowth({ count, oldestAgeSeconds }) : { firing: false, reason: null };
	return {
		signal: def.signal,
		scope: null,
		rowKey: def.signal,
		severity: def.severity,
		firing: decision.firing,
		reason: decision.reason,
		observed: count,
		threshold: `>= ${HELD_BACKLOG_COUNT_THRESHOLD} items or oldest >= ${HELD_BACKLOG_OLDEST_SECONDS}s`,
		window: null,
		runbook: def.runbook,
		digest: `${count}|${work.oldestAt?.toISOString() ?? "none"}`,
		approximate: false,
		evidence: {
			held,
			epoch,
			pendingAnalyses: work.counts.a,
			receiptsWithoutAnalysis: work.counts.b,
			oldestAt: work.oldestAt?.toISOString() ?? null,
			oldestAgeSeconds,
		},
	};
}

interface PermitRow {
	id: string;
	purpose: string;
	state: string;
	phase_budget: Record<string, number>;
	estimated_cost_budget_usd: string;
	settled_cost_usd: string;
	reserved_estimate_usd: string;
	expired: boolean;
	analysis_id: string;
	analysis_status: string;
	verified: boolean;
	case_status: string | null;
}

const AUTOMATIC_CASE_STATUSES: ReadonlySet<string> = new Set(["open", "repairing", "verifying", "retry_wait"]);
const TERMINAL_ANALYSIS_STATUSES: ReadonlySet<string> = new Set(["completed", "no_mentions", "failed"]);

function permitSnapshotOf(r: PermitRow): PermitSnapshot {
	const automaticCase = r.case_status === null || AUTOMATIC_CASE_STATUSES.has(r.case_status);
	return {
		id: r.id,
		purpose: r.purpose,
		state: r.state,
		phaseBudget: r.phase_budget ?? {},
		estimatedCostBudgetUsd: Number(r.estimated_cost_budget_usd),
		settledCostUsd: Number(r.settled_cost_usd),
		reservedEstimateUsd: Number(r.reserved_estimate_usd),
		expired: r.expired,
		lifecycleAutomatic: automaticCase && !TERMINAL_ANALYSIS_STATUSES.has(r.analysis_status),
		verified: r.verified,
		caseStatus: r.case_status,
	};
}

function permitExhaustedObservation(r: PermitRow, snapshot: PermitSnapshot): AlertObservation {
	const def = alertDefinition("permit-exhausted");
	const reason = decidePermitExhausted(snapshot);
	const urgent = reason !== null && snapshot.purpose === "canary" && !snapshot.verified;
	return {
		signal: def.signal,
		scope: r.id,
		rowKey: alertRowKey(def.signal, r.id),
		severity: urgent ? "urgent" : def.severity,
		firing: reason !== null,
		reason,
		observed: reason !== null ? 1 : 0,
		threshold: "phase budgets all 0 / state exhausted, or active permit expired while the lifecycle is unresolved",
		window: null,
		runbook: def.runbook,
		digest: reason ?? "none",
		approximate: false,
		evidence: {
			permitId: r.id,
			purpose: r.purpose,
			state: r.state,
			phaseBudget: snapshot.phaseBudget,
			settledCostUsd: snapshot.settledCostUsd,
			reservedEstimateUsd: snapshot.reservedEstimateUsd,
			estimatedCostBudgetUsd: snapshot.estimatedCostBudgetUsd,
			expired: r.expired,
			analysisId: r.analysis_id,
			analysisStatus: r.analysis_status,
			caseStatus: r.case_status,
			verified: r.verified,
		},
	};
}

function reserveExceededObservation(r: PermitRow, snapshot: PermitSnapshot): AlertObservation {
	const def = alertDefinition("reserve-exceeded");
	const blocked = reserveBlockedPhases(snapshot);
	return {
		signal: def.signal,
		scope: r.id,
		rowKey: alertRowKey(def.signal, r.id),
		severity: def.severity,
		firing: blocked.length > 0,
		reason: blocked.length > 0 ? "reservation-predicate-unsatisfiable" : null,
		observed: blocked.length,
		threshold: "settled + reserved + R_next <= estimated budget for every phase with budget 1",
		window: null,
		runbook: def.runbook,
		digest:
			blocked.length > 0
				? `${blocked.join(",")}|${snapshot.settledCostUsd}|${snapshot.reservedEstimateUsd}|${snapshot.estimatedCostBudgetUsd}`
				: "none",
		approximate: false,
		evidence: {
			permitId: r.id,
			purpose: r.purpose,
			blockedPhases: blocked,
			settledCostUsd: snapshot.settledCostUsd,
			reservedEstimateUsd: snapshot.reservedEstimateUsd,
			estimatedCostBudgetUsd: snapshot.estimatedCostBudgetUsd,
			estimates: RESERVATION_ESTIMATES_USD,
			analysisId: r.analysis_id,
			note: RESERVATION_ESTIMATE_NOTE,
		},
	};
}

async function observePermits(executor: Executor): Promise<AlertObservation[]> {
	const { rows } = await execute<PermitRow>(
		executor,
		sql`select p.id::text, p.purpose, p.state, p.phase_budget, p.estimated_cost_budget_usd::text, p.settled_cost_usd::text,
				p.reserved_estimate_usd::text, (p.expires_at <= now()) as expired, p.analysis_id::text, a.status as analysis_status,
				(a.verified_at is not null) as verified, c.status as case_status
			from sentiment_dispatch_permits p
			join sentiment_analyses a on a.id = p.analysis_id
			left join sentiment_resolution_cases c on c.analysis_id = p.analysis_id and c.instance_id = p.instance_id
			where p.state in ('issued', 'active', 'exhausted') order by p.id`,
	);
	return rows.flatMap((r) => {
		const snapshot = permitSnapshotOf(r);
		return [permitExhaustedObservation(r, snapshot), reserveExceededObservation(r, snapshot)];
	});
}

async function observeGateBreaches(executor: Executor): Promise<AlertObservation[]> {
	const def = alertDefinition("gate-breach");
	const { rows } = await execute<{
		analysis_id: string;
		error_code: string;
		attempt_id: string | null;
		phase: string | null;
	}>(
		executor,
		sql`select a.id::text as analysis_id, a.error_code,
				(select p.id::text from sentiment_provider_attempts p where p.analysis_id = a.id and p.outcome = 'aborted'
					order by p.ordinal desc limit 1) as attempt_id,
				(select p.phase from sentiment_provider_attempts p where p.analysis_id = a.id and p.outcome = 'aborted'
					order by p.ordinal desc limit 1) as phase
			from sentiment_analyses a where a.error_code like 'gate-breach:%' order by a.id`,
	);
	return rows.map((r) => {
		const scope = r.analysis_id;
		const code = r.error_code.slice("gate-breach:".length).slice(0, 64);
		return {
			signal: def.signal,
			scope,
			rowKey: alertRowKey(def.signal, scope),
			severity: def.severity,
			firing: true,
			reason: code,
			observed: 1,
			threshold: "any occurrence",
			window: null,
			runbook: def.runbook,
			digest: `${r.analysis_id}:${code}:${r.attempt_id ?? "none"}`,
			approximate: false,
			evidence: { analysisId: r.analysis_id, code, attemptId: r.attempt_id, phase: r.phase },
		};
	});
}

// ---------------------------------------------------------------------------
// Persistence and notification
// ---------------------------------------------------------------------------

export interface PersistedAlert {
	observation: AlertObservation;
	decision: NotificationDecision;
	record: SentimentAlertRecord | null;
	cooldownUntil: Date | null;
}

/**
 * Persist one observation on its state row (locked) and decide the
 * notification. The row is updated in every case — `evaluated_at`, the
 * observed digest and the signal's watermark — so a restart resumes from
 * durable facts; only a notification writes `last_alerted_at`/`cooldown_until`
 * and the audit event. Nothing here touches any other table.
 */
async function persistObservation(
	tx: Executor,
	observation: AlertObservation,
	definition: AlertSignalDefinition,
	now: Date,
): Promise<PersistedAlert> {
	await execute(
		tx,
		sql`insert into sentiment_alert_state (signal, updated_by, correlation_id, updated_at)
			values (${observation.rowKey}, 'system:alert-evaluator', 'amendment-d', now()) on conflict (signal) do nothing`,
	);
	const [locked] = await tx
		.select()
		.from(sentimentAlertState)
		.where(eq(sentimentAlertState.signal, observation.rowKey))
		.for("update");
	const previous = watermarkOf(locked ?? null);
	const decision = decideNotification({
		signal: observation.signal,
		firing: observation.firing,
		digest: observation.digest,
		previous,
		cooldownUntil: locked?.cooldownUntil ?? null,
		now,
	});
	const cooldownUntil = decision.notify
		? new Date(now.getTime() + definition.cooldownSeconds * 1000)
		: (locked?.cooldownUntil ?? null);
	const watermark: AlertWatermark = {
		v: 1,
		...previous,
		...observation.watermark,
		observedDigest: observation.digest,
		firing: observation.firing,
		reason: observation.reason,
		severity: observation.severity,
		lastNotifiedDigest: decision.notify ? observation.digest : (previous?.lastNotifiedDigest ?? null),
		ack: previous?.ack ?? null,
	};
	for (const key of Object.keys(watermark) as (keyof AlertWatermark)[])
		if (watermark[key] === undefined) delete watermark[key];
	await tx
		.update(sentimentAlertState)
		.set({
			watermark,
			evaluatedAt: now,
			lastAlertedAt: decision.notify ? now : (locked?.lastAlertedAt ?? null),
			cooldownUntil,
			updatedBy: "system:alert-evaluator",
			correlationId: "amendment-d",
			updatedAt: now,
		})
		.where(eq(sentimentAlertState.signal, observation.rowKey));
	let record: SentimentAlertRecord | null = null;
	if (decision.notify) {
		record = {
			v: 1,
			kind: "sentiment-alert",
			signal: observation.signal,
			scope: observation.scope,
			rowKey: observation.rowKey,
			severity: observation.severity,
			reason: observation.reason,
			observed: observation.observed,
			threshold: observation.threshold,
			window: observation.window,
			runbook: observation.runbook,
			digest: observation.digest,
			evidence: observation.evidence,
			approximate: observation.approximate,
			evaluatedAt: now.toISOString(),
			alertedAt: now.toISOString(),
			cooldownUntil: (cooldownUntil as Date).toISOString(),
			...(observation.signal === "reserve-exceeded" ? { note: RESERVATION_ESTIMATE_NOTE } : {}),
		};
		await appendControlEvent(tx, {
			subjectKind: "alert",
			subjectKey: observation.rowKey,
			fromState: previous?.firing ? "firing" : "quiet",
			toState: "raised",
			evidence: {
				signal: observation.signal,
				scope: observation.scope,
				severity: observation.severity,
				reason: observation.reason,
				observed: observation.observed,
				threshold: observation.threshold,
				runbook: observation.runbook,
				digest: observation.digest,
				approximate: observation.approximate,
				cooldownUntil: record.cooldownUntil,
			},
			actor: "system:alert-evaluator",
			reason:
				"alert condition observed by the maintenance evaluator; notification recorded (delivery is not asserted here)",
			correlationId: "amendment-d",
		});
	}
	return { observation, decision, record, cooldownUntil };
}

export interface AlertEvaluationDeps {
	executor?: Executor;
	notify?: AlertSink;
}

export interface AlertEvaluationResult {
	evaluatedAt: string;
	held: boolean;
	baseline: { captured: string[]; present: string[]; missing: string[]; rebuilt: string[] };
	evaluatedSignals: string[];
	observations: number;
	raised: SentimentAlertRecord[];
	suppressed: number;
	active: number;
	notifyFailures: number;
}

/**
 * One evaluation of the ten evaluator-owned signals. Baselines are captured
 * only under HELD (R9); a growth signal without a baseline is reported as
 * missing and skipped rather than invented. Notifications are emitted after
 * their transaction committed, so a sink failure never loses the audit row
 * and the audit row never claims delivery.
 */
const GROWTH_ROWS = [
	{ rowKey: "awaiting-review-growth", where: sql`status = 'awaiting_review'` },
	{ rowKey: "first-contract-defect", where: sql`status = 'awaiting_review' and review_reason = 'contract-defect'` },
] as const;

interface BaselineReport {
	captured: string[];
	present: string[];
	missing: string[];
	rebuilt: string[];
}

function fallbackNotice(count: number, now: Date): AlertObservation {
	const def = alertDefinition("awaiting-review-growth");
	return {
		signal: def.signal,
		scope: AWAITING_REVIEW_FALLBACK_SCOPE,
		rowKey: alertRowKey(def.signal, AWAITING_REVIEW_FALLBACK_SCOPE),
		severity: "informational",
		firing: true,
		reason: "baseline-count-fallback",
		observed: count,
		threshold: `> ${AWAITING_REVIEW_EXACT_ID_LIMIT} open ids`,
		window: null,
		runbook: def.runbook,
		digest: `entered:${now.toISOString()}`,
		approximate: true,
		evidence: {
			approximate: true,
			currentCount: count,
			limit: AWAITING_REVIEW_EXACT_ID_LIMIT,
			note: "awaiting-review-growth degraded to count-delta precision; exact ids are no longer persisted",
		},
	};
}

/** The two baseline-bound growth signals (plus the Q4 degradation notice when the mode flips). */
async function observeGrowthSignals(
	executor: Executor,
	held: boolean,
	now: Date,
	baseline: BaselineReport,
): Promise<AlertObservation[]> {
	const observations: AlertObservation[] = [];
	for (const { rowKey, where } of GROWTH_ROWS) {
		const state = await loadState(executor, rowKey);
		const base = baselineOf(state);
		if (!base) {
			baseline.missing.push(rowKey);
			continue;
		}
		const cases = await observeCases(executor, where);
		let effectiveBase = base;
		const degraded = base.mode === "count-delta" || watermarkOf(state)?.mode === "count-delta";
		if (held && degraded && cases.count <= AWAITING_REVIEW_EXACT_ID_LIMIT) {
			effectiveBase = await rebuildExactBaseline(executor, rowKey, cases.ids, now);
			baseline.rebuilt.push(rowKey);
		}
		const grown = observeGrowth({
			rowKey,
			definition: alertDefinition(rowKey),
			currentIds: cases.ids,
			currentCount: cases.count,
			countsByReason: cases.countsByReason,
			oldestAgeSeconds: cases.oldestAgeSeconds,
			baseline: effectiveBase,
			previous: effectiveBase === base ? watermarkOf(state) : null,
			held,
		});
		observations.push(grown.observation);
		if (rowKey === "awaiting-review-growth" && grown.fallbackEntered && grown.observation.approximate) {
			observations.push(fallbackNotice(cases.count, now));
		}
	}
	return observations;
}

/**
 * One evaluation of the ten evaluator-owned signals. Baselines are captured
 * only under HELD (R9); a growth signal without a baseline is reported as
 * missing and skipped rather than invented. Notifications are emitted after
 * their transaction committed, so a sink failure never loses the audit row
 * and the audit row never claims delivery.
 */
export async function evaluateSentimentAlerts(deps: AlertEvaluationDeps = {}): Promise<AlertEvaluationResult> {
	const executor = deps.executor ?? db;
	const notify = deps.notify ?? logAlertSink;
	const dispatch = await readDispatchState(executor);
	const held = isHeld(dispatch);
	const now = await databaseNow(executor);
	const baseline: BaselineReport = { captured: [], present: [], missing: [], rebuilt: [] };
	if (held) {
		const result = await captureAlertBaselines(executor);
		baseline.captured = result.captured;
		baseline.present = result.present;
	}
	const observations: AlertObservation[] = [
		...(await observeGrowthSignals(executor, held, now, baseline)),
		...(await observeBreakers(executor)),
		await observeRefusalsAcrossShapes(executor),
		...(await observeProviderRefusals(executor)),
		await observeHeldBacklog(executor, held, dispatch.epoch),
		...(await observePermits(executor)),
		...(await observeGateBreaches(executor)),
	];
	const tally = { raised: [] as SentimentAlertRecord[], suppressed: 0, active: 0, notifyFailures: 0 };
	for (const observation of observations) {
		// Rows for scoped signals are created only once they fire, so quiet scopes never accumulate state.
		if (!observation.firing && observation.scope !== null && !(await loadState(executor, observation.rowKey))) continue;
		const definition = alertDefinition(observation.signal);
		const persisted = await executor.transaction((tx) => persistObservation(tx, observation, definition, now));
		if (persisted.decision.active) tally.active += 1;
		if (observation.firing && !persisted.decision.notify) tally.suppressed += 1;
		if (!persisted.record) continue;
		tally.raised.push(persisted.record);
		try {
			assertEmittableAlertRecord(persisted.record);
			await notify(persisted.record);
		} catch (error) {
			tally.notifyFailures += 1;
			console.error(
				`[sentiment-alert] sink failed for ${persisted.record.rowKey}: ${error instanceof Error ? error.name : "error"}`,
			);
		}
	}
	return {
		evaluatedAt: now.toISOString(),
		held,
		baseline,
		evaluatedSignals: EVALUATOR_SIGNALS.map((s) => s.signal),
		observations: observations.length,
		...tally,
	};
}

/** Q4 return path: the population fits again, so the exact id baseline is rebuilt under HELD, audited as a mode transition. */
async function rebuildExactBaseline(executor: Executor, rowKey: string, ids: string[], now: Date): Promise<Baseline> {
	const baseline: Baseline = { mode: "exact", ids: [...ids].sort(), count: ids.length, capturedAt: now.toISOString() };
	await executor.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(sentimentAlertState)
			.where(eq(sentimentAlertState.signal, rowKey))
			.for("update");
		const previous = watermarkOf(locked ?? null);
		const watermark: AlertWatermark = {
			v: 1,
			observedDigest: null,
			firing: false,
			reason: null,
			lastNotifiedDigest: previous?.lastNotifiedDigest ?? null,
			ack: null,
			mode: "exact",
			ackedIds: [],
			newIds: [],
			precisionDegraded: false,
		};
		await tx
			.update(sentimentAlertState)
			.set({ baseline, watermark, updatedBy: "system:alert-evaluator", correlationId: "amendment-d", updatedAt: now })
			.where(eq(sentimentAlertState.signal, rowKey));
		await appendControlEvent(tx, {
			subjectKind: "alert",
			subjectKey: rowKey,
			fromState: "count-delta",
			toState: "exact",
			evidence: { count: ids.length, limit: AWAITING_REVIEW_EXACT_ID_LIMIT },
			actor: "system:alert-evaluator",
			reason:
				"open population within the exact-id limit again; baseline rebuilt from the current rows under a held dispatch",
			correlationId: "amendment-d",
		});
	});
	return baseline;
}

// ---------------------------------------------------------------------------
// Acknowledgement (operator, audited, compare-and-set)
// ---------------------------------------------------------------------------

export type AlertAckResult =
	| { acknowledged: true; rowKey: string; digest: string; mode: "exact" | "count-delta" | "state"; eventSeq: number }
	| {
			acknowledged: false;
			rowKey: string;
			reason: "unknown-row" | "digest-mismatch" | "already-acknowledged";
			currentDigest: string | null;
	  };

/**
 * Acknowledge the evidence an operator has seen: exact-mode growth rows merge
 * the observed new ids into the acknowledged set, count-delta rows advance the
 * count watermark, every other row records the acknowledged digest. The
 * `expectedDigest` must equal the row's current observed digest, so evidence
 * that arrived after the operator looked is never acknowledged blind. Only
 * the alert-state row and its audit are written; attempts, cases, costs and
 * provider evidence are never touched.
 */
type AckMode = "exact" | "count-delta" | "state";

/** Compare-and-set refusals never write; the current digest is returned so the operator can look again. */
function ackRefusal(previous: AlertWatermark | null, rowKey: string, expectedDigest: string): AlertAckResult | null {
	const current = previous?.observedDigest ?? null;
	if (current === null || current !== expectedDigest) {
		return { acknowledged: false, rowKey, reason: "digest-mismatch", currentDigest: current };
	}
	if (previous?.ack?.digest === current) {
		return { acknowledged: false, rowKey, reason: "already-acknowledged", currentDigest: current };
	}
	return null;
}

/** The acknowledged watermark: exact rows merge the seen ids, count-delta rows advance the count, others record the digest. */
function acknowledgedWatermark(previous: AlertWatermark, ack: AlertAck): { next: AlertWatermark; mode: AckMode } {
	const mode: AckMode = previous.mode === "count-delta" ? "count-delta" : previous.mode === "exact" ? "exact" : "state";
	const next: AlertWatermark = { ...previous, v: 1, ack, firing: false };
	if (mode === "exact") {
		next.ackedIds = [...new Set([...(previous.ackedIds ?? []), ...(previous.newIds ?? [])])].sort();
		next.newIds = [];
	} else if (mode === "count-delta") {
		const observedCount = Number((previous.observedDigest ?? "count-delta:0").split(":")[1] ?? 0);
		next.watermarkCount = Math.max(previous.watermarkCount ?? 0, observedCount);
	}
	return { next, mode };
}

export async function acknowledgeSentimentAlert(
	args: { rowKey: string; expectedDigest: string } & Partial<ControlActor>,
	executor: Executor = db,
): Promise<AlertAckResult> {
	const who = requireActor(args);
	alertDefinition(parseAlertRowKey(args.rowKey).signal);
	return executor.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(sentimentAlertState)
			.where(eq(sentimentAlertState.signal, args.rowKey))
			.for("update");
		if (!locked) return { acknowledged: false, rowKey: args.rowKey, reason: "unknown-row", currentDigest: null };
		const previous = watermarkOf(locked);
		const refusal = ackRefusal(previous, args.rowKey, args.expectedDigest);
		if (refusal || !previous)
			return refusal ?? { acknowledged: false, rowKey: args.rowKey, reason: "digest-mismatch", currentDigest: null };
		const now = await databaseNow(tx);
		const ack: AlertAck = {
			digest: args.expectedDigest,
			actor: who.actor,
			correlationId: who.correlationId,
			at: now.toISOString(),
		};
		const { next, mode } = acknowledgedWatermark(previous, ack);
		await tx
			.update(sentimentAlertState)
			.set({ watermark: next, updatedBy: who.actor, correlationId: who.correlationId, updatedAt: now })
			.where(eq(sentimentAlertState.signal, args.rowKey));
		const event = await appendControlEvent(tx, {
			subjectKind: "alert",
			subjectKey: args.rowKey,
			fromState: previous.firing ? "firing" : "quiet",
			toState: "acknowledged",
			evidence: {
				digest: ack.digest,
				mode,
				ackedCount: mode === "exact" ? next.ackedIds?.length : undefined,
				watermarkCount: mode === "count-delta" ? next.watermarkCount : undefined,
				approximate: mode === "count-delta",
			},
			...who,
		});
		return { acknowledged: true, rowKey: args.rowKey, digest: ack.digest, mode, eventSeq: event.seq };
	});
}

// ---------------------------------------------------------------------------
// Heartbeat and status (durable evidence for the host watchdog, F2-PR-3)
// ---------------------------------------------------------------------------

export interface MaintenanceHeartbeat {
	v: 1;
	workerBootId: string;
	source: string;
	stages: { name: string; ok: true; ms: number }[];
	alerts: { evaluated: number; raised: number; suppressed: number; active: number } | null;
}

/** Written last in a maintenance tick, with the database clock; never on a partial or failed tick. */
export async function writeMaintenanceHeartbeat(
	heartbeat: MaintenanceHeartbeat,
	executor: Executor = db,
): Promise<void> {
	await execute(
		executor,
		sql`insert into sentiment_alert_state (signal, watermark, evaluated_at, updated_by, correlation_id, updated_at)
			values (${MAINTENANCE_HEARTBEAT_KEY}, ${JSON.stringify(heartbeat)}::jsonb, now(), 'system:schedule-maintenance', 'amendment-d', now())
			on conflict (signal) do update set watermark = excluded.watermark, evaluated_at = now(),
				updated_by = excluded.updated_by, correlation_id = excluded.correlation_id, updated_at = now()`,
	);
}

export const HEARTBEAT_STALE_SECONDS = 15 * 60;

export interface HeartbeatStatus {
	present: boolean;
	evaluatedAt: string | null;
	ageSeconds: number | null;
	stale: boolean;
	heartbeat: MaintenanceHeartbeat | null;
}

export async function readMaintenanceHeartbeat(executor: Executor = db): Promise<HeartbeatStatus> {
	const { rows } = await execute<{
		evaluated_at: string | null;
		age_seconds: string | null;
		watermark: MaintenanceHeartbeat | null;
	}>(
		executor,
		sql`select evaluated_at::text, extract(epoch from now() - evaluated_at)::text as age_seconds, watermark
			from sentiment_alert_state where signal = ${MAINTENANCE_HEARTBEAT_KEY}`,
	);
	const row = rows[0];
	if (!row || row.evaluated_at === null)
		return { present: false, evaluatedAt: null, ageSeconds: null, stale: true, heartbeat: null };
	const age = Math.max(0, Math.floor(Number(row.age_seconds)));
	return {
		present: true,
		evaluatedAt: new Date(row.evaluated_at).toISOString(),
		ageSeconds: age,
		stale: age > HEARTBEAT_STALE_SECONDS,
		heartbeat: row.watermark,
	};
}

export interface AlertStateSummary {
	rowKey: string;
	signal: string;
	scope: string | null;
	owner: string;
	severity: AlertSeverity;
	runbook: string;
	firing: boolean;
	active: boolean;
	cooling: boolean;
	reason: string | null;
	observedDigest: string | null;
	acknowledged: boolean;
	approximate: boolean;
	mode: "exact" | "count-delta" | null;
	evaluatedAt: string | null;
	lastAlertedAt: string | null;
	cooldownUntil: string | null;
}

/** Every persisted alert row (never the heartbeat), classified by the database clock. */
export async function listAlertStates(executor: Executor = db): Promise<AlertStateSummary[]> {
	const { rows } = await execute<{
		signal: string;
		watermark: AlertWatermark | null;
		evaluated_at: string | null;
		last_alerted_at: string | null;
		cooldown_until: string | null;
		cooling: boolean;
	}>(
		executor,
		sql`select signal, watermark, evaluated_at::text, last_alerted_at::text, cooldown_until::text,
				(cooldown_until is not null and cooldown_until > now()) as cooling
			from sentiment_alert_state where signal <> ${MAINTENANCE_HEARTBEAT_KEY} order by signal`,
	);
	const summaries: AlertStateSummary[] = [];
	for (const row of rows) {
		const { signal, scope } = parseAlertRowKey(row.signal);
		const def = ALERT_SIGNALS.find((s) => s.signal === signal);
		if (!def) continue;
		const w = row.watermark;
		const firing = w?.firing === true;
		const acknowledged = w?.ack !== null && w?.ack !== undefined && w.ack.digest === w.observedDigest;
		summaries.push({
			rowKey: row.signal,
			signal,
			scope,
			owner: def.owner,
			severity: w?.severity ?? def.severity,
			runbook: def.runbook,
			firing,
			active: firing && !acknowledged,
			cooling: row.cooling,
			reason: w?.reason ?? null,
			observedDigest: w?.observedDigest ?? null,
			acknowledged,
			approximate: w?.precisionDegraded === true || w?.mode === "count-delta",
			mode: w?.mode ?? null,
			evaluatedAt: row.evaluated_at ? new Date(row.evaluated_at).toISOString() : null,
			lastAlertedAt: row.last_alerted_at ? new Date(row.last_alerted_at).toISOString() : null,
			cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until).toISOString() : null,
		});
	}
	return summaries;
}
