import { describe, expect, it } from "vitest";
import {
	type AlertWatermark,
	assertEmittableAlertRecord,
	awaitingReviewThreshold,
	decideAwaitingReviewGrowth,
	decideHeldBacklogGrowth,
	decideNotification,
	decidePermitExhausted,
	decideRefusalsAcrossShapes,
	type PermitSnapshot,
	reserveBlockedPhases,
	type SentimentAlertRecord,
	sentimentAlertFingerprint,
	sentimentAlertLevel,
} from "../alerts";
import { STATUS_EXIT, statusExitCode } from "../status-report";

const T0 = new Date("2026-09-22T10:00:00Z");
const plus = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("D9 awaiting-review-growth thresholds", () => {
	it.each([
		[0, 5],
		[1, 1],
		[4, 1],
		[8, 2],
		[12, 3],
		[16, 4],
		[20, 5],
		[52, 5],
		[400, 5],
	])(
		"baseline %i → threshold %i (absolute 5, relative ceil(0.25 x baseline) only above zero)",
		(baseline, threshold) => {
			expect(awaitingReviewThreshold(baseline)).toBe(threshold);
		},
	);

	it("with a zero baseline only the absolute threshold applies: 4 is quiet, 5 fires", () => {
		expect(decideAwaitingReviewGrowth({ newCount: 4, baselineCount: 0 })).toEqual({ firing: false, threshold: 5 });
		expect(decideAwaitingReviewGrowth({ newCount: 5, baselineCount: 0 })).toEqual({ firing: true, threshold: 5 });
	});

	it("with a non-zero baseline the relative threshold may fire first: baseline 12 → 2 quiet, 3 fires", () => {
		expect(decideAwaitingReviewGrowth({ newCount: 2, baselineCount: 12 })).toEqual({ firing: false, threshold: 3 });
		expect(decideAwaitingReviewGrowth({ newCount: 3, baselineCount: 12 })).toEqual({ firing: true, threshold: 3 });
	});
});

describe("D10 held-backlog-growth", () => {
	it.each([
		[19, null, false, null],
		[20, null, true, "count"],
		[0, 48 * 3600 - 1, false, null],
		[1, 48 * 3600, true, "age"],
		[25, 48 * 3600, true, "count"],
	])("count %i / oldest %s → firing %s (%s)", (count, oldest, firing, reason) => {
		expect(decideHeldBacklogGrowth({ count, oldestAgeSeconds: oldest })).toEqual({ firing, reason });
	});
});

describe("D8 refusals-across-shapes", () => {
	it("needs two distinct request-profile scopes", () => {
		expect(decideRefusalsAcrossShapes(0)).toBe(false);
		expect(decideRefusalsAcrossShapes(1)).toBe(false);
		expect(decideRefusalsAcrossShapes(2)).toBe(true);
	});
});

const permit = (over: Partial<PermitSnapshot>): PermitSnapshot => ({
	id: "p",
	purpose: "canary",
	state: "issued",
	phaseBudget: { classify: 1, repair: 1, verify: 1 },
	estimatedCostBudgetUsd: 0.1,
	settledCostUsd: 0,
	reservedEstimateUsd: 0,
	expired: false,
	lifecycleAutomatic: true,
	verified: false,
	caseStatus: "open",
	...over,
});

describe("Q2 permit-exhausted mapping onto migration 0024", () => {
	it("exhausted + unresolved fires with phase-budget-exhausted", () => {
		expect(
			decidePermitExhausted(permit({ state: "exhausted", phaseBudget: { classify: 0, repair: 0, verify: 0 } })),
		).toBe("phase-budget-exhausted");
		expect(decidePermitExhausted(permit({ state: "active", phaseBudget: { classify: 0, repair: 0, verify: 0 } }))).toBe(
			"phase-budget-exhausted",
		);
	});
	it("exhausted + resolved (verified) does not fire", () => {
		expect(
			decidePermitExhausted(
				permit({ state: "exhausted", phaseBudget: { classify: 0, repair: 0, verify: 0 }, verified: true }),
			),
		).toBeNull();
	});
	it("issued + expired + unused does not fire", () => {
		expect(decidePermitExhausted(permit({ state: "issued", expired: true }))).toBeNull();
	});
	it("active + expired + unresolved fires with active-expired-unresolved", () => {
		expect(
			decidePermitExhausted(
				permit({ state: "active", expired: true, phaseBudget: { classify: 0, repair: 1, verify: 1 } }),
			),
		).toBe("active-expired-unresolved");
	});
	it("a phase blocked only by the reservation predicate is reserve-exceeded, never permit-exhausted", () => {
		const p = permit({
			state: "active",
			phaseBudget: { classify: 0, repair: 0, verify: 1 },
			settledCostUsd: 0.05,
			reservedEstimateUsd: 0.04,
		});
		expect(decidePermitExhausted(p)).toBeNull();
		expect(reserveBlockedPhases(p)).toEqual(["verify"]);
	});
	it("a lifecycle parked for review or reconciliation, a revoked permit and an expired row never fire", () => {
		const spent = { classify: 0, repair: 0, verify: 0 };
		expect(
			decidePermitExhausted(
				permit({ state: "exhausted", phaseBudget: spent, lifecycleAutomatic: false, caseStatus: "awaiting_review" }),
			),
		).toBeNull();
		expect(
			decidePermitExhausted(
				permit({ state: "active", expired: true, lifecycleAutomatic: false, caseStatus: "awaiting_reconciliation" }),
			),
		).toBeNull();
		expect(decidePermitExhausted(permit({ state: "revoked", phaseBudget: spent }))).toBeNull();
		expect(decidePermitExhausted(permit({ state: "expired", phaseBudget: spent }))).toBeNull();
	});
});

describe("reserve-exceeded predicate", () => {
	it("holds at equality and fails one cent past the planning budget (verify estimate 0.02)", () => {
		const exact = permit({
			state: "active",
			phaseBudget: { classify: 0, repair: 0, verify: 1 },
			settledCostUsd: 0.05,
			reservedEstimateUsd: 0.03,
		});
		expect(reserveBlockedPhases(exact)).toEqual([]);
		expect(reserveBlockedPhases({ ...exact, reservedEstimateUsd: 0.04 })).toEqual(["verify"]);
	});
	it("ignores phases whose budget is already 0, expired or non-live permits and resolved lifecycles", () => {
		const p = permit({ state: "active", phaseBudget: { classify: 0, repair: 0, verify: 1 }, settledCostUsd: 0.09 });
		expect(reserveBlockedPhases({ ...p, phaseBudget: { classify: 0, repair: 0, verify: 0 } })).toEqual([]);
		expect(reserveBlockedPhases({ ...p, expired: true })).toEqual([]);
		expect(reserveBlockedPhases({ ...p, state: "exhausted" })).toEqual([]);
		expect(reserveBlockedPhases({ ...p, verified: true })).toEqual([]);
		expect(reserveBlockedPhases(p)).toEqual(["verify"]);
	});
});

const previous = (over: Partial<AlertWatermark>): AlertWatermark => ({
	v: 1,
	observedDigest: "d1",
	firing: true,
	reason: null,
	lastNotifiedDigest: "d1",
	ack: null,
	...over,
});

describe("notification decision: cooldown, acknowledgement, re-arm", () => {
	it("a quiet observation never notifies and is not active", () => {
		expect(
			decideNotification({
				signal: "breaker-open",
				firing: false,
				digest: "closed",
				previous: null,
				cooldownUntil: null,
				now: T0,
			}),
		).toEqual({
			notify: false,
			active: false,
			cooling: false,
			suppressedBy: "not-firing",
		});
	});
	it("a first firing notifies; the same state within the cooldown is persisted but silent; after the cooldown it notifies again", () => {
		expect(
			decideNotification({
				signal: "breaker-open",
				firing: true,
				digest: "d1",
				previous: null,
				cooldownUntil: null,
				now: T0,
			}).notify,
		).toBe(true);
		const during = decideNotification({
			signal: "breaker-open",
			firing: true,
			digest: "d1",
			previous: previous({}),
			cooldownUntil: plus(3600),
			now: plus(10),
		});
		expect(during).toEqual({ notify: false, active: true, cooling: true, suppressedBy: "unchanged" });
		const after = decideNotification({
			signal: "breaker-open",
			firing: true,
			digest: "d1",
			previous: previous({}),
			cooldownUntil: plus(3600),
			now: plus(3600),
		});
		expect(after.notify).toBe(true);
	});
	it("changed evidence inside the cooldown stays silent for time-deduped signals but re-arms permit-bound and per-occurrence signals", () => {
		const args = { firing: true, digest: "d2", previous: previous({}), cooldownUntil: plus(3600), now: plus(10) };
		expect(decideNotification({ signal: "breaker-open", ...args })).toEqual({
			notify: false,
			active: true,
			cooling: true,
			suppressedBy: "cooldown",
		});
		expect(decideNotification({ signal: "awaiting-review-growth", ...args }).notify).toBe(false);
		for (const signal of ["reserve-exceeded", "permit-exhausted", "gate-breach"]) {
			expect(decideNotification({ signal, ...args }).notify, signal).toBe(true);
		}
	});
	it("acknowledged evidence is neither active nor notified until the evidence changes", () => {
		const acked = previous({ ack: { digest: "d1", actor: "op", correlationId: "c", at: T0.toISOString() } });
		expect(
			decideNotification({
				signal: "gate-breach",
				firing: true,
				digest: "d1",
				previous: acked,
				cooldownUntil: null,
				now: plus(99999),
			}),
		).toEqual({
			notify: false,
			active: false,
			cooling: false,
			suppressedBy: "acknowledged",
		});
		expect(
			decideNotification({
				signal: "gate-breach",
				firing: true,
				digest: "d2",
				previous: acked,
				cooldownUntil: null,
				now: plus(99999),
			}).notify,
		).toBe(true);
	});
});

describe("emission contract", () => {
	const record: SentimentAlertRecord = {
		v: 1,
		kind: "sentiment-alert",
		signal: "breaker-open",
		scope: "rp1:abc",
		rowKey: "breaker-open|rp1:abc",
		severity: "urgent",
		reason: "request-refused-400",
		observed: 1,
		threshold: "state = open",
		window: null,
		runbook: "RB-2",
		digest: "open:x:1",
		evidence: { scopeKey: "rp1:abc", lastHttpStatus: 400 },
		approximate: false,
		evaluatedAt: T0.toISOString(),
		alertedAt: T0.toISOString(),
		cooldownUntil: plus(3600).toISOString(),
	};
	it("groups by signal and scope only, so repeated ticks and changing digests fold into one issue", () => {
		expect(sentimentAlertFingerprint(record)).toEqual(["sentiment-alert", "breaker-open", "rp1:abc"]);
		const changed: SentimentAlertRecord = { ...record, digest: "other" };
		expect(sentimentAlertFingerprint(changed)).toEqual(sentimentAlertFingerprint(record));
		expect(sentimentAlertFingerprint({ ...record, scope: null })).toEqual([
			"sentiment-alert",
			"breaker-open",
			"global",
		]);
		expect(sentimentAlertLevel("urgent")).toBe("error");
		expect(sentimentAlertLevel("informational")).toBe("info");
	});
	it("refuses a record with an unknown key, sensitive evidence names or unbounded values", () => {
		expect(() => assertEmittableAlertRecord(record)).not.toThrow();
		expect(() => assertEmittableAlertRecord({ ...record, prompt: "x" } as unknown as SentimentAlertRecord)).toThrow(
			/unknown key/,
		);
		for (const key of [
			"prompt",
			"answerBody",
			"candidate",
			"schemaDocument",
			"apiKey",
			"authorization",
			"responseBody",
		]) {
			expect(() => assertEmittableAlertRecord({ ...record, evidence: { [key]: "x" } }), key).toThrow(/must not carry/);
		}
		expect(() => assertEmittableAlertRecord({ ...record, evidence: { nested: { text: "a".repeat(600) } } })).toThrow(
			/not bounded/,
		);
	});
});

describe("status exit-code selection (contract v1)", () => {
	const heartbeat = (over: Partial<{ present: boolean; stale: boolean }>) => ({
		present: true,
		evaluatedAt: T0.toISOString(),
		ageSeconds: 10,
		stale: false,
		heartbeat: null,
		...over,
	});
	const alerts = (active: { severity: "urgent" | "informational" }[]) =>
		({
			active,
			cooling: [],
			acknowledged: [],
			all: [],
			registry: { total: 11, evaluatorOwned: 10, hostOwned: 1 },
			evaluatedHere: [],
			notEvaluatedHere: [],
		}) as never;
	const held = { state: "held" as const, epoch: 1, readable: true as const };
	const open = { state: "open" as const, epoch: 2, readable: true as const };
	it("keeps 10 for a held dispatch and nothing worse, 0 for a healthy open dispatch", () => {
		expect(statusExitCode({ dispatch: held, heartbeat: heartbeat({}), alerts: alerts([]) })).toBe(STATUS_EXIT.held);
		expect(statusExitCode({ dispatch: open, heartbeat: heartbeat({}), alerts: alerts([]) })).toBe(STATUS_EXIT.ok);
		expect(
			statusExitCode({ dispatch: held, heartbeat: heartbeat({}), alerts: alerts([{ severity: "informational" }]) }),
		).toBe(10);
	});
	it("an active urgent alert is 20 and a missing or stale heartbeat is 30, in that precedence", () => {
		expect(statusExitCode({ dispatch: open, heartbeat: heartbeat({}), alerts: alerts([{ severity: "urgent" }]) })).toBe(
			20,
		);
		expect(
			statusExitCode({
				dispatch: held,
				heartbeat: heartbeat({ stale: true }),
				alerts: alerts([{ severity: "urgent" }]),
			}),
		).toBe(30);
		expect(
			statusExitCode({ dispatch: open, heartbeat: heartbeat({ present: false, stale: true }), alerts: alerts([]) }),
		).toBe(30);
		expect(STATUS_EXIT).toEqual({ ok: 0, held: 10, urgent: 20, heartbeatStale: 30, failed: 40 });
	});
});
