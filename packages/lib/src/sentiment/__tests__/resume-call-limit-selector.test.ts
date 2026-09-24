import { describe, expect, it } from "vitest";
import {
	CALL_LIMIT_RESUMABLE_PATH,
	selectCallLimitCandidate,
	selectResumeCandidate,
	selectStoredCandidate,
	selectVerifierRejectedCandidate,
} from "../resume";

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
type Attempt = Parameters<typeof selectCallLimitCandidate>[0][number];
let ordinal = 0;
const attempt = (over: Partial<Attempt>): Attempt =>
	({
		id: `att-${++ordinal}`,
		analysisId: "a1",
		instanceId: INSTANCE,
		ordinal,
		phase: "classify",
		provider: "openrouter",
		model: "openai/gpt-5-mini",
		generationId: `gen-${ordinal}`,
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
	}) as Attempt;
/** The exact parked-repair path: verdicts are accepted (paid) verify answers whose reject lives in the case. */
const exactPath = () => [
	attempt({ phase: "classify" }),
	attempt({ phase: "verify", candidate: null }),
	attempt({ phase: "repair" }),
	attempt({ phase: "verify", candidate: null }),
	attempt({ phase: "repair" }),
];

describe("call-limit verify-only resume: the stored-candidate invariant", () => {
	it("the resumable path is frozen as classify → verify → repair → verify → repair", () => {
		expect([...CALL_LIMIT_RESUMABLE_PATH]).toEqual(["classify", "verify", "repair", "verify", "repair"]);
	});

	it("accepts the exact path and reuses the parked (fifth) repair candidate", () => {
		const attempts = exactPath();
		const picked = selectCallLimitCandidate(attempts, INSTANCE, HASH);
		expect("attempt" in picked && picked.attempt.id).toBe(attempts[4].id);
		expect("attempt" in picked && picked.attempt.phase).toBe("repair");
		expect(selectResumeCandidate("call-limit", attempts, INSTANCE, HASH)).toEqual(picked);
	});

	it("excludes a wrong call count (four answered attempts)", () => {
		const attempts = exactPath().slice(0, 4);
		expect(selectCallLimitCandidate(attempts, INSTANCE, HASH)).toEqual({ reason: "wrong-call-count" });
	});

	it("excludes the deterministic-target parity path (classify then four repairs)", () => {
		const attempts = [
			attempt({ phase: "classify" }),
			attempt({ phase: "repair" }),
			attempt({ phase: "repair" }),
			attempt({ phase: "repair" }),
			attempt({ phase: "repair" }),
		];
		expect(selectCallLimitCandidate(attempts, INSTANCE, HASH)).toEqual({ reason: "wrong-path" });
	});

	it("excludes a path whose last verify was refused rather than answered", () => {
		const attempts = exactPath();
		attempts[3] = attempt({ phase: "verify", outcome: "provider-error", generationId: null, actualCostUsd: null });
		// Only four answered attempts remain, so the count rule fires first; the shape is not resumable either way.
		expect("reason" in selectCallLimitCandidate(attempts, INSTANCE, HASH)).toBe(true);
	});

	it("excludes a later attempt after the parked repair, even an unpaid one", () => {
		const attempts = [
			...exactPath(),
			attempt({ phase: "verify", outcome: "provider-error", generationId: null, actualCostUsd: null, candidate: null }),
		];
		expect(selectCallLimitCandidate(attempts, INSTANCE, HASH)).toEqual({ reason: "later-attempt" });
	});

	it("excludes any sending or aborted attempt anywhere on the analysis", () => {
		for (const outcome of ["sending", "aborted"] as const) {
			const attempts = [
				...exactPath(),
				attempt({ instanceId: "inst-other", outcome, generationId: null, actualCostUsd: null }),
			];
			expect(selectCallLimitCandidate(attempts, INSTANCE, HASH)).toEqual({ reason: "sending-or-unknown-attempt" });
		}
	});

	it("excludes attempts of another instance and a drifted input hash", () => {
		const other = exactPath().map((a) => ({ ...a, instanceId: "inst-old" }));
		expect(selectCallLimitCandidate(other, INSTANCE, HASH)).toEqual({ reason: "wrong-call-count" });
		const drifted = exactPath();
		drifted[4] = { ...drifted[4], inputHash: "x".repeat(64) };
		expect(selectCallLimitCandidate(drifted, INSTANCE, HASH)).toEqual({ reason: "no-accepted-candidate" });
	});

	it("excludes a malformed parked candidate", () => {
		const attempts = exactPath();
		attempts[4] = { ...attempts[4], candidate: { entities: [{ key: "brand" }] } };
		expect(selectCallLimitCandidate(attempts, INSTANCE, HASH)).toEqual({ reason: "candidate-malformed" });
	});

	it("the contract-defect rule is untouched: a paid or accepted verify still excludes", () => {
		expect(selectStoredCandidate(exactPath(), INSTANCE, HASH)).toEqual({ reason: "paid-or-accepted-verify" });
		expect(selectResumeCandidate("contract-defect", exactPath(), INSTANCE, HASH)).toEqual({
			reason: "paid-or-accepted-verify",
		});
	});
});

describe("verifier-rejected repair-resume: the stored-candidate invariant", () => {
	const verifierTargets = [
		{
			entityKey: "brand",
			reason: "verifier:polarity-mismatch",
			aspectKey: null,
			anchorId: "s0001",
			source: "verifier",
		},
	];
	const rejectedPath = () => [
		attempt({ phase: "classify" }),
		attempt({ phase: "verify", candidate: null }),
		attempt({ phase: "repair" }),
		attempt({ phase: "verify", candidate: null }),
	];

	it("accepts the pair-rule product and reuses the candidate the verifier judged (the latest repair)", () => {
		const attempts = rejectedPath();
		const picked = selectVerifierRejectedCandidate(attempts, INSTANCE, HASH, verifierTargets);
		expect("attempt" in picked && picked.attempt.id).toBe(attempts[2].id);
		expect(selectResumeCandidate("verifier-rejected", attempts, INSTANCE, HASH, verifierTargets)).toEqual(picked);
	});

	it("excludes deterministic or missing targets, a path not ending in an accepted verify, a later attempt and unknown outcomes", () => {
		const attempts = rejectedPath();
		expect(selectVerifierRejectedCandidate(attempts, INSTANCE, HASH, [])).toEqual({ reason: "targets-not-verifier" });
		expect(
			selectVerifierRejectedCandidate(attempts, INSTANCE, HASH, [{ ...verifierTargets[0], source: "deterministic" }]),
		).toEqual({ reason: "targets-not-verifier" });
		expect(selectVerifierRejectedCandidate(exactPath(), INSTANCE, HASH, verifierTargets)).toEqual({
			reason: "no-rejecting-verify",
		});
		// A refusal that never answered after the rejecting verify is not evidence and spends nothing: still eligible.
		const unpaidAfter = [
			...attempts,
			attempt({
				phase: "repair",
				outcome: "provider-error",
				generationId: null,
				actualCostUsd: null,
				candidate: null,
				permitId: "permit-x",
			}),
		];
		expect("attempt" in selectVerifierRejectedCandidate(unpaidAfter, INSTANCE, HASH, verifierTargets)).toBe(true);
		// A paid later attempt that is not a verify does exclude.
		expect(
			selectVerifierRejectedCandidate([...attempts, attempt({ phase: "repair" })], INSTANCE, HASH, verifierTargets),
		).toEqual({ reason: "no-rejecting-verify" });
		expect(
			selectVerifierRejectedCandidate(
				[...attempts, attempt({ phase: "repair", outcome: "sending", generationId: null, actualCostUsd: null })],
				INSTANCE,
				HASH,
				verifierTargets,
			),
		).toEqual({ reason: "sending-or-unknown-attempt" });
		const drifted = rejectedPath();
		drifted[2] = { ...drifted[2], inputHash: "x".repeat(64) };
		expect(selectVerifierRejectedCandidate(drifted, INSTANCE, HASH, verifierTargets)).toEqual({
			reason: "no-accepted-candidate",
		});
	});

	it("excludes an instance that already spent its permitted pair (a permit-bound attempt exists)", () => {
		const spent = [
			...rejectedPath(),
			attempt({ phase: "repair", permitId: "permit-1" }),
			attempt({ phase: "verify", candidate: null, permitId: "permit-1" }),
		];
		expect(selectVerifierRejectedCandidate(spent, INSTANCE, HASH, verifierTargets)).toEqual({
			reason: "pair-already-spent",
		});
	});

	it("the verify-only selectors still refuse a case with paid verifies", () => {
		expect(selectStoredCandidate(rejectedPath(), INSTANCE, HASH)).toEqual({ reason: "paid-or-accepted-verify" });
		expect(selectCallLimitCandidate(rejectedPath(), INSTANCE, HASH)).toEqual({ reason: "wrong-call-count" });
	});
});
