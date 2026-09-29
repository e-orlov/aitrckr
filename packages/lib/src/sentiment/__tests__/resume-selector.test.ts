import { describe, expect, it } from "vitest";
import { selectStoredCandidate } from "../resume";

const INSTANCE = "inst-current";
const HASH = "h".repeat(64);
const candidate = {
	entities: [
		{
			key: "brand",
			score: 70,
			category: "positive",
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
	],
};
let ordinal = 0;
const attempt = (over: Partial<Parameters<typeof selectStoredCandidate>[0][number]>) =>
	({
		id: `att-${++ordinal}`,
		analysisId: "a1",
		instanceId: INSTANCE,
		ordinal,
		phase: "classify",
		provider: "openrouter",
		model: "openai/gpt-5-mini",
		generationId: "gen-1",
		inputHash: HASH,
		outcome: "accepted",
		actualCostUsd: "0.020000",
		candidate,
		permitId: null,
		scopeKey: null,
		schemaFp: null,
		reservedEstimateUsd: null,
		startedAt: new Date(),
		finishedAt: new Date(),
		...over,
	}) as Parameters<typeof selectStoredCandidate>[0][number];
const unpaidVerify = () =>
	attempt({ phase: "verify", outcome: "provider-error", generationId: null, actualCostUsd: null, candidate: null });

describe("verifier-only resume: the stored-candidate predicate", () => {
	it("accepts the incident shape: accepted classify, then an unpaid refused verify", () => {
		const attempts = [attempt({}), unpaidVerify()];
		const picked = selectStoredCandidate(attempts, INSTANCE, HASH);
		expect("attempt" in picked && picked.attempt.id).toBe(attempts[0].id);
	});

	it("excludes the two rejected classify candidates structurally: the accepted repair is the latest candidate", () => {
		const rejected = attempt({ outcome: "rejected", generationId: "gen-r" });
		const repair = attempt({ phase: "repair", generationId: "gen-p" });
		const picked = selectStoredCandidate([rejected, repair, unpaidVerify()], INSTANCE, HASH);
		expect("attempt" in picked && picked.attempt.id).toBe(repair.id);
		expect("attempt" in picked && picked.attempt.phase).toBe("repair");
	});

	it("refuses when the only accepted candidate belongs to another instance", () => {
		const picked = selectStoredCandidate([attempt({ instanceId: "inst-old" }), unpaidVerify()], INSTANCE, HASH);
		expect(picked).toEqual({ reason: "candidate-outside-instance" });
	});

	it("refuses when the latest candidate was built for another input", () => {
		const picked = selectStoredCandidate([attempt({ inputHash: "x".repeat(64) }), unpaidVerify()], INSTANCE, HASH);
		expect(picked).toEqual({ reason: "no-accepted-candidate" });
	});

	it("refuses a malformed candidate", () => {
		const picked = selectStoredCandidate(
			[attempt({ candidate: { entities: [{ key: 7 }] } }), unpaidVerify()],
			INSTANCE,
			HASH,
		);
		expect(picked).toEqual({ reason: "candidate-malformed" });
	});

	it("refuses when any attempt is still sending or was aborted", () => {
		expect(
			selectStoredCandidate([attempt({}), attempt({ phase: "verify", outcome: "sending" })], INSTANCE, HASH),
		).toEqual({
			reason: "sending-or-unknown-attempt",
		});
		expect(
			selectStoredCandidate([attempt({}), attempt({ phase: "verify", outcome: "aborted" })], INSTANCE, HASH),
		).toEqual({
			reason: "sending-or-unknown-attempt",
		});
	});

	it("refuses when a verify attempt was ever paid or accepted", () => {
		expect(
			selectStoredCandidate(
				[attempt({}), attempt({ phase: "verify", outcome: "rejected", generationId: "gen-v" })],
				INSTANCE,
				HASH,
			),
		).toEqual({ reason: "paid-or-accepted-verify" });
		expect(
			selectStoredCandidate(
				[
					attempt({}),
					attempt({ phase: "verify", outcome: "provider-error", generationId: null, actualCostUsd: "0.001000" }),
				],
				INSTANCE,
				HASH,
			),
		).toEqual({ reason: "paid-or-accepted-verify" });
	});

	it("refuses when the latest classify/repair of the instance is not accepted", () => {
		expect(selectStoredCandidate([attempt({ outcome: "rejected" }), unpaidVerify()], INSTANCE, HASH)).toEqual({
			reason: "no-accepted-candidate",
		});
	});
});
