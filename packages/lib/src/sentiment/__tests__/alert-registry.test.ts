import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALERT_SIGNALS,
	alertRowKey,
	EVALUATOR_SIGNALS,
	HOST_SIGNALS,
	NOT_EVALUATED_HERE,
	parseAlertRowKey,
} from "../alert-registry";
import { evaluateSentimentAlerts } from "../alerts";
import { buildSentimentStatusReport } from "../status-report";

/**
 * The owner-approved inventory (Amendment D). A silent addition, removal,
 * rename, owner change, severity change or cooldown change fails here.
 */
const APPROVED: [signal: string, owner: string, severity: string, cooldownSeconds: number, runbook: string][] = [
	["first-contract-defect", "maintenance-evaluator", "urgent", 6 * 3600, "RB-1"],
	["breaker-open", "maintenance-evaluator", "urgent", 3600, "RB-2"],
	["probe-failed-or-expired", "maintenance-evaluator", "urgent", 3600, "RB-3"],
	["refusals-across-shapes", "maintenance-evaluator", "urgent", 6 * 3600, "RB-4"],
	["provider-refusal-config", "maintenance-evaluator", "urgent", 6 * 3600, "RB-10"],
	["awaiting-review-growth", "maintenance-evaluator", "informational", 24 * 3600, "RB-5"],
	["held-backlog-growth", "maintenance-evaluator", "informational", 24 * 3600, "RB-6"],
	["permit-exhausted", "maintenance-evaluator", "informational", 24 * 3600, "RB-7"],
	["reserve-exceeded", "maintenance-evaluator", "informational", 24 * 3600, "RB-11"],
	["gate-breach", "maintenance-evaluator", "urgent", 24 * 3600, "RB-8"],
	["alert-delivery-failure", "host-watchdog", "urgent", 3600, "RB-9"],
];

describe("alert registry (Amendment D inventory)", () => {
	it("holds exactly the eleven approved signals, in order, with their owners, severities, cooldowns and runbooks", () => {
		expect(ALERT_SIGNALS.map((s) => [s.signal, s.owner, s.severity, s.cooldownSeconds, s.runbook])).toEqual(APPROVED);
		expect(ALERT_SIGNALS).toHaveLength(11);
		expect(new Set(ALERT_SIGNALS.map((s) => s.signal)).size).toBe(11);
	});

	it("splits ownership 10 / 1 and the evaluator claims exactly the ten evaluator-owned names", () => {
		expect(EVALUATOR_SIGNALS.map((s) => s.signal)).toEqual(APPROVED.slice(0, 10).map(([s]) => s));
		expect(HOST_SIGNALS.map((s) => s.signal)).toEqual(["alert-delivery-failure"]);
		// The evaluator result names its signals from the registry, never from a second list, and never names the host signal.
		const source = readFileSync(join(__dirname, "..", "alerts.ts"), "utf8");
		expect(source).toContain("evaluatedSignals: EVALUATOR_SIGNALS.map((s) => s.signal)");
		expect(source).not.toContain('"alert-delivery-failure"');
	});

	it("marks the host-owned signal as not evaluated here in the status contract", () => {
		expect(NOT_EVALUATED_HERE).toBe("not-evaluated-here");
		const source = readFileSync(join(__dirname, "..", "status-report.ts"), "utf8");
		expect(source).toContain(
			"notEvaluatedHere: HOST_SIGNALS.map((s) => ({ signal: s.signal, owner: s.owner, marker: NOT_EVALUATED_HERE }))",
		);
		expect(typeof buildSentimentStatusReport).toBe("function");
		expect(typeof evaluateSentimentAlerts).toBe("function");
	});

	it("never transitions dispatch, a breaker or a permit and never reaches a provider", () => {
		const source = readFileSync(join(__dirname, "..", "alerts.ts"), "utf8");
		for (const forbidden of [
			"transitionDispatch(",
			"openBreaker(",
			"openBreakerManually(",
			"resetBreaker(",
			"issuePermit(",
			"revokePermit(",
			"consumePermitPhase(",
			"runStructuredResearch",
			"fetch(",
			"sentiment_controls",
		]) {
			expect(source, forbidden).not.toContain(forbidden);
		}
	});

	it("row keys round-trip and refuse a scope that would be ambiguous", () => {
		expect(alertRowKey("breaker-open", null)).toBe("breaker-open");
		expect(alertRowKey("breaker-open", "rp1:abc")).toBe("breaker-open|rp1:abc");
		expect(parseAlertRowKey("breaker-open|rp1:abc")).toEqual({ signal: "breaker-open", scope: "rp1:abc" });
		expect(parseAlertRowKey("held-backlog-growth")).toEqual({ signal: "held-backlog-growth", scope: null });
		expect(() => alertRowKey("breaker-open", "a|b")).toThrow(/without/);
		expect(() => alertRowKey("breaker-open", "")).toThrow(/1-200/);
	});
});
