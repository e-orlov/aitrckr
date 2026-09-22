/**
 * The canonical inventory of sentiment dispatch alert signals (ADR-SENT-01,
 * Amendment D). Eleven logical signals exist; the maintenance evaluator owns
 * and evaluates exactly ten of them, and the host watchdog (F2-PR-3) owns
 * `alert-delivery-failure`, because a process cannot prove that its own
 * heartbeat stopped or that its own last notification was delivered. No
 * signal may transition dispatch: alerting observes, the operator decides.
 */

export const ALERT_OWNERS = ["maintenance-evaluator", "host-watchdog"] as const;
export type AlertOwner = (typeof ALERT_OWNERS)[number];

export const ALERT_SEVERITIES = ["urgent", "informational"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** How one signal's state rows are keyed: one row, or one row per scope (`signal|scope`). */
export type AlertScopeKind = "global" | "breaker-scope" | "provider-model-status" | "permit" | "occurrence";

const HOUR = 3600;
const DAY = 24 * HOUR;

export interface AlertSignalDefinition {
	readonly signal: string;
	readonly owner: AlertOwner;
	readonly severity: AlertSeverity;
	readonly scope: AlertScopeKind;
	/** Notification cooldown per state row, seconds (D11). */
	readonly cooldownSeconds: number;
	/** Rolling observation window in seconds, when the signal has one. */
	readonly windowSeconds: number | null;
	readonly runbook: string;
	readonly summary: string;
}

/**
 * The frozen inventory. Order is the reporting order; names, owners,
 * severities and cooldowns are contract (the registry test refuses a silent
 * change).
 */
export const ALERT_SIGNALS: readonly AlertSignalDefinition[] = Object.freeze([
	{
		signal: "first-contract-defect",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "global",
		cooldownSeconds: 6 * HOUR,
		windowSeconds: null,
		runbook: "RB-1",
		summary: "a case entered awaiting_review/contract-defect outside the captured baseline",
	},
	{
		signal: "breaker-open",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "breaker-scope",
		cooldownSeconds: HOUR,
		windowSeconds: null,
		runbook: "RB-2",
		summary: "a request-profile breaker transitioned to open",
	},
	{
		signal: "probe-failed-or-expired",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "breaker-scope",
		cooldownSeconds: HOUR,
		windowSeconds: null,
		runbook: "RB-3",
		summary: "a half-open probe was refused deterministically or its lease passed without an outcome",
	},
	{
		signal: "refusals-across-shapes",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "global",
		cooldownSeconds: 6 * HOUR,
		windowSeconds: DAY,
		runbook: "RB-4",
		summary: "class-2 request refusals in two or more distinct request-profile scopes within 24 h (D8)",
	},
	{
		signal: "provider-refusal-config",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "provider-model-status",
		cooldownSeconds: 6 * HOUR,
		windowSeconds: DAY,
		runbook: "RB-10",
		summary: "the provider refused a request with HTTP 401, 402 or 403 (credentials, credit or permissions)",
	},
	{
		signal: "awaiting-review-growth",
		owner: "maintenance-evaluator",
		severity: "informational",
		scope: "global",
		cooldownSeconds: DAY,
		windowSeconds: DAY,
		runbook: "RB-5",
		summary: "new unacknowledged awaiting_review cases beyond the D9 thresholds",
	},
	{
		signal: "held-backlog-growth",
		owner: "maintenance-evaluator",
		severity: "informational",
		scope: "global",
		cooldownSeconds: DAY,
		windowSeconds: null,
		runbook: "RB-6",
		summary: "held work reached 20 items or an oldest age of 48 h (D10)",
	},
	{
		signal: "permit-exhausted",
		owner: "maintenance-evaluator",
		severity: "informational",
		scope: "permit",
		cooldownSeconds: DAY,
		windowSeconds: null,
		runbook: "RB-7",
		summary:
			"a permitted lifecycle is stranded: its call authorization was consumed or expired before verified completion",
	},
	{
		signal: "reserve-exceeded",
		owner: "maintenance-evaluator",
		severity: "informational",
		scope: "permit",
		cooldownSeconds: DAY,
		windowSeconds: null,
		runbook: "RB-11",
		summary: "a still-required permitted phase cannot satisfy the planning reservation predicate",
	},
	{
		signal: "gate-breach",
		owner: "maintenance-evaluator",
		severity: "urgent",
		scope: "occurrence",
		cooldownSeconds: DAY,
		windowSeconds: null,
		runbook: "RB-8",
		summary: "the provider boundary guard refused a request an earlier gate should have stopped (code defect)",
	},
	{
		signal: "alert-delivery-failure",
		owner: "host-watchdog",
		severity: "urgent",
		scope: "global",
		cooldownSeconds: HOUR,
		windowSeconds: null,
		runbook: "RB-9",
		summary:
			"the maintenance heartbeat is stale or the status command cannot run — decided by the host watchdog (F2-PR-3)",
	},
]);

export type AlertSignalName = (typeof ALERT_SIGNALS)[number]["signal"];

export const EVALUATOR_SIGNALS: readonly AlertSignalDefinition[] = Object.freeze(
	ALERT_SIGNALS.filter((s) => s.owner === "maintenance-evaluator"),
);
export const HOST_SIGNALS: readonly AlertSignalDefinition[] = Object.freeze(
	ALERT_SIGNALS.filter((s) => s.owner === "host-watchdog"),
);

/** Marker the status contract carries for signals this process never evaluates. */
export const NOT_EVALUATED_HERE = "not-evaluated-here" as const;

export function alertDefinition(signal: string): AlertSignalDefinition {
	const def = ALERT_SIGNALS.find((s) => s.signal === signal);
	if (!def) throw new Error(`unknown alert signal "${signal}"`);
	return def;
}

/** Row keys in `sentiment_alert_state`: the signal itself, or `signal|scope` for scoped signals. */
export const ALERT_ROW_SEPARATOR = "|";
export function alertRowKey(signal: string, scope: string | null): string {
	if (scope === null) return signal;
	if (scope.includes(ALERT_ROW_SEPARATOR) || scope.length === 0 || scope.length > 200) {
		throw new Error(`alert scope must be 1-200 characters without "${ALERT_ROW_SEPARATOR}"`);
	}
	return `${signal}${ALERT_ROW_SEPARATOR}${scope}`;
}
export function parseAlertRowKey(rowKey: string): { signal: string; scope: string | null } {
	const idx = rowKey.indexOf(ALERT_ROW_SEPARATOR);
	return idx === -1 ? { signal: rowKey, scope: null } : { signal: rowKey.slice(0, idx), scope: rowKey.slice(idx + 1) };
}

/** Row key of the durable maintenance heartbeat (not a signal; never notifies). */
export const MAINTENANCE_HEARTBEAT_KEY = "maintenance_heartbeat";
/** Row key of the awaiting-review count-delta degradation notice (Q4): a scoped condition of `awaiting-review-growth`, not a signal. */
export const AWAITING_REVIEW_FALLBACK_SCOPE = "baseline-count-fallback";
/** Open-id population above which `awaiting-review-growth` degrades to count-delta precision (Q4). */
export const AWAITING_REVIEW_EXACT_ID_LIMIT = 5000;
