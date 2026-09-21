import type { Provider } from "../../providers/types";
import { breakerBackoffMs } from "../breaker";
import type { DispatchState, PermitPhase } from "../controls";
import type { DispatchDeps, SentimentJobDeps } from "../job";
import { SENTIMENT_MODEL } from "../types";

/**
 * In-memory doubles of the resolution store (cases + attempt ledger) and a
 * provider that answers every non-classification phase, for unit tests of the
 * job/canary core that run without Postgres. The classification itself is
 * stubbed by the test (`deps.classify` or a scripted provider).
 */
const phaseOf = (prompt: string) =>
	prompt.startsWith("You are an independent verifier")
		? "verify"
		: prompt.startsWith("You are repairing")
			? "repair"
			: "classify";

export interface FakePermit {
	id: string;
	purpose: "canary" | "resume-verify";
	analysisId: string;
	instanceId: string;
	inputHash: string;
	phaseBudget: Record<PermitPhase, 0 | 1>;
	estimatedCostBudgetUsd: number;
	settledCostUsd: number;
	reservedEstimateUsd: number;
	state: "issued" | "active" | "exhausted" | "expired" | "revoked";
	expiresAt: Date;
}

export interface FakeBreaker {
	scopeKey: string;
	state: "closed" | "open" | "half_open";
	openUntil: Date | null;
	probeAttemptId: string | null;
	probeGeneration: number;
	probeLeaseUntil: Date | null;
	consecutiveFailures: number;
	openedClass: string | null;
	schemaFp: string;
	events: string[];
}

export function resolutionFakes(
	options: {
		verifierVerdict?: unknown;
		repairAnswer?: unknown;
		/** Dispatch control state the fakes report; open unless a test holds it. */
		dispatch?: DispatchState;
		now?: () => Date;
	} = {},
) {
	const cases = new Map<string, Record<string, unknown>>();
	const now = options.now ?? (() => new Date());
	const control = { state: options.dispatch ?? ({ state: "open", epoch: 1, readable: true } as DispatchState) };
	const permits: FakePermit[] = [];
	const breakers = new Map<string, FakeBreaker>();
	const attempts: {
		id: string;
		analysisId: string;
		instanceId: string;
		ordinal: number;
		phase: string;
		outcome: string;
		generationId: string | null;
		actualCostUsd: string | null;
		candidate: unknown;
		inputHash: string;
		permitId: string | null;
		scopeKey: string | null;
		schemaFp: string | null;
		startedAt: Date;
	}[] = [];
	const calls: { phase: string; prompt: string }[] = [];
	const deps: Partial<SentimentJobDeps> = {
		// Rolls the in-memory store back on failure, as the real transaction would.
		transaction: async (fn) => {
			const attemptsBefore = attempts.map((a) => ({ ...a }));
			const casesBefore = new Map([...cases].map(([k, v]) => [k, { ...v }]));
			try {
				return await fn(undefined as never);
			} catch (error) {
				attempts.splice(0, attempts.length, ...attemptsBefore);
				for (const [k, v] of casesBefore) Object.assign(cases.get(k) ?? {}, v);
				throw error;
			}
		},
		loadResolutionCase: async (analysisId) => (cases.get(analysisId) as never) ?? null,
		ensureResolutionCase: async (analysisId, inputHash) => {
			const existing = cases.get(analysisId);
			if (existing && existing.inputHash === inputHash) return existing as never;
			const row = {
				analysisId,
				instanceId: `inst-${analysisId}-${cases.size + 1}-${inputHash.slice(0, 8)}`,
				inputHash,
				status: "open",
				provisionalResult: null,
				unresolvedTargets: [],
				automatedProviderCalls: 0,
				totalActualCostUsd: "0",
				nextAttemptAt: null,
				reviewReason: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			cases.set(analysisId, row);
			return row as never;
		},
		updateResolutionCase: async (analysisId, patch) => {
			const row = cases.get(analysisId);
			if (row) Object.assign(row, patch, { updatedAt: new Date() });
		},
		chargeResolutionCase: async (analysisId, owner) => {
			const row = cases.get(analysisId) as { automatedProviderCalls: number; totalActualCostUsd: string };
			const paid = attempts.filter(
				(a) =>
					a.analysisId === analysisId &&
					a.instanceId === owner.instanceId &&
					(a.outcome === "accepted" || a.outcome === "rejected"),
			);
			row.automatedProviderCalls = paid.length;
			row.totalActualCostUsd = paid.reduce((sum, a) => sum + Number(a.actualCostUsd ?? 0), 0).toFixed(6);
			return { automatedProviderCalls: row.automatedProviderCalls, totalActualCostUsd: Number(row.totalActualCostUsd) };
		},
		openProviderAttempt: async ({ analysisId, phase, inputHash, claim, id, permitId, scopeKey, schemaFp }) => {
			const ordinal = attempts.filter((a) => a.analysisId === analysisId).length + 1;
			const row = {
				id: id ?? `att-${analysisId}-${ordinal}`,
				analysisId,
				instanceId: claim.instanceId,
				ordinal,
				phase,
				outcome: "sending",
				generationId: null,
				actualCostUsd: null,
				candidate: null,
				inputHash,
				permitId: permitId ?? null,
				scopeKey: scopeKey ?? null,
				schemaFp: schemaFp ?? null,
				startedAt: new Date(),
			};
			attempts.push(row);
			return { id: row.id, ordinal };
		},
		finishProviderAttempt: async (id, args) => {
			const row = attempts.find((a) => a.id === id);
			if (!row) throw new Error(`provider attempt ${id} missing`);
			const generationId = args.generationId ?? null;
			const actualCostUsd = typeof args.actualCostUsd === "number" ? args.actualCostUsd.toFixed(6) : null;
			if (row.outcome !== "sending") {
				const same =
					row.outcome === args.outcome && row.generationId === generationId && row.actualCostUsd === actualCostUsd;
				if (!same) throw new Error(`attempt ${id} is already settled with different evidence`);
				return "already-settled";
			}
			row.outcome = args.outcome;
			row.generationId = generationId;
			row.actualCostUsd = actualCostUsd;
			row.candidate = args.candidate ?? null;
			return "settled";
		},
		loadProviderAttempts: async (analysisId) =>
			attempts
				.filter((a) => a.analysisId === analysisId)
				.map((a) => ({
					...a,
					provider: "openrouter",
					model: SENTIMENT_MODEL,
					finishedAt: null,
				})) as never,
	};
	const dispatch: DispatchDeps = {
		readDispatchState: async () => control.state,
		databaseNow: async () => now(),
		findLivePermit: async ({ analysisId, instanceId, inputHash }) =>
			(permits.find(
				(p) =>
					p.analysisId === analysisId &&
					p.instanceId === instanceId &&
					p.inputHash === inputHash &&
					(p.state === "issued" || p.state === "active") &&
					p.expiresAt.getTime() > now().getTime(),
			) as never) ?? null,
		consumePermitPhase: async (_tx, { analysisId, instanceId, inputHash, phase, reserveUsd }) => {
			const p = permits.find(
				(x) =>
					x.analysisId === analysisId &&
					x.instanceId === instanceId &&
					x.inputHash === inputHash &&
					(x.state === "issued" || x.state === "active"),
			);
			if (!p) return { consumed: false, reason: "no-live-permit" };
			if (p.expiresAt.getTime() <= now().getTime()) return { consumed: false, reason: "expired" };
			if (p.phaseBudget[phase] !== 1) return { consumed: false, reason: "phase-exhausted" };
			if (p.settledCostUsd + p.reservedEstimateUsd + reserveUsd > p.estimatedCostBudgetUsd + 1e-9) {
				return { consumed: false, reason: "estimate-budget-exhausted" };
			}
			p.phaseBudget[phase] = 0;
			p.reservedEstimateUsd += reserveUsd;
			p.state = "active";
			return { consumed: true, permitId: p.id, reservedEstimateUsd: reserveUsd };
		},
		settlePermitReservation: async (_tx, { permitId, reservedEstimateUsd, settlement }) => {
			const p = permits.find((x) => x.id === permitId);
			if (!p) return;
			// Mirrors the store: an unpriced paid answer keeps its reservation counted; nothing is fabricated as $0.
			if (settlement.kind !== "paid-unknown-cost") {
				p.reservedEstimateUsd = Math.max(0, p.reservedEstimateUsd - reservedEstimateUsd);
			}
			if (settlement.kind === "paid") p.settledCostUsd += Math.max(0, settlement.actualCostUsd);
			if (Object.values(p.phaseBudget).every((v) => v === 0)) p.state = "exhausted";
		},
		loadPermit: async (id) => {
			const p = permits.find((x) => x.id === id);
			return p
				? ({
						...p,
						estimatedCostBudgetUsd: p.estimatedCostBudgetUsd.toFixed(6),
						settledCostUsd: p.settledCostUsd.toFixed(6),
						reservedEstimateUsd: p.reservedEstimateUsd.toFixed(6),
					} as never)
				: null;
		},
		readBreaker: async (scopeKey) => (breakers.get(scopeKey) as never) ?? null,
		acquireProbe: async (_tx, scopeKey, attemptId) => {
			const b = breakers.get(scopeKey);
			if (!b) return null;
			const t = now().getTime();
			const claimable =
				(b.state === "open" && b.openUntil !== null && b.openUntil.getTime() <= t) ||
				(b.state === "half_open" && (b.probeAttemptId === null || (b.probeLeaseUntil?.getTime() ?? 0) < t));
			if (!claimable) return null;
			b.state = "half_open";
			b.probeAttemptId = attemptId;
			b.probeGeneration += 1;
			b.probeLeaseUntil = new Date(t + 900_000);
			b.events.push("probe");
			return { generation: b.probeGeneration };
		},
		openBreaker: async (_tx, evidence) => {
			const open = (key: string, schemaFp: string) => {
				const b = breakers.get(key) ?? {
					scopeKey: key,
					state: "closed" as const,
					openUntil: null,
					probeAttemptId: null,
					probeGeneration: 0,
					probeLeaseUntil: null,
					consecutiveFailures: 0,
					openedClass: null,
					schemaFp,
					events: [] as string[],
				};
				b.consecutiveFailures += 1;
				b.state = "open";
				b.openUntil = new Date(now().getTime() + breakerBackoffMs(b.consecutiveFailures));
				b.probeAttemptId = null;
				b.probeLeaseUntil = null;
				b.openedClass = evidence.failureClass;
				b.events.push(`open:${evidence.failureClass}`);
				breakers.set(key, b);
			};
			open(evidence.scopeKey, evidence.schemaFp);
			if (evidence.failureClass === "local-contract") {
				for (const b of [...breakers.values()]) {
					if (b.scopeKey !== evidence.scopeKey && b.schemaFp === evidence.schemaFp && b.state !== "open") {
						open(b.scopeKey, b.schemaFp);
					}
				}
			}
		},
		settleProbe: async (_tx, { scopeKey, attemptId, generation, outcome }) => {
			if (outcome === "untouched") return "untouched";
			const b = breakers.get(scopeKey);
			if (!b || b.probeAttemptId !== attemptId || b.probeGeneration !== generation) return "fenced";
			if (outcome === "released") {
				b.probeAttemptId = null;
				b.probeLeaseUntil = null;
				b.events.push("released");
				return "released";
			}
			if (outcome === "accepted") {
				Object.assign(b, {
					state: "closed",
					consecutiveFailures: 0,
					openUntil: null,
					probeAttemptId: null,
					probeLeaseUntil: null,
				});
				b.events.push("closed");
				return "closed";
			}
			b.consecutiveFailures += 1;
			Object.assign(b, {
				state: "open",
				openUntil: new Date(now().getTime() + breakerBackoffMs(b.consecutiveFailures)),
				probeAttemptId: null,
				probeLeaseUntil: null,
			});
			b.events.push("reopened");
			return "reopened";
		},
		loadAttemptDispatch: async (id) => {
			const row = attempts.find((a) => a.id === id);
			return row
				? { outcome: row.outcome as never, permitId: row.permitId, scopeKey: row.scopeKey, schemaFp: row.schemaFp }
				: null;
		},
	};
	deps.dispatch = dispatch;
	/** Answers the verifier (accept by default) and, when given, repairs; classification calls are the test's own. */
	const phasesProvider = (classify?: Provider): Provider =>
		({
			...(classify ?? { id: "openrouter" }),
			id: classify?.id ?? "openrouter",
			async runStructuredResearch(opts: { prompt: string; schema: { parse: (v: unknown) => unknown } }) {
				const phase = phaseOf(opts.prompt);
				calls.push({ phase, prompt: opts.prompt });
				if (phase === "classify") {
					if (!classify?.runStructuredResearch) throw new Error("no classification provider in this test");
					return classify.runStructuredResearch(opts as never);
				}
				const answer =
					phase === "verify" ? (options.verifierVerdict ?? { verdict: "accept", issues: [] }) : options.repairAnswer;
				if (answer === undefined) throw new Error(`unscripted ${phase} call`);
				return {
					object: opts.schema.parse(answer),
					modelVersion: SENTIMENT_MODEL,
					generationId: `gen-fake-${phase}-${calls.length}`,
					usage: {
						inputTokens: 100,
						outputTokens: 20,
						reasoningTokens: 0,
						costUsd: 0.001,
						webSearchRequests: 0,
						webSearchRequestsConflict: false,
					},
				};
			},
		}) as unknown as Provider;
	/** Issue an in-memory permit bound to one instance and input. */
	const issuePermit = (
		permit: Omit<FakePermit, "state" | "settledCostUsd" | "reservedEstimateUsd" | "purpose"> & {
			purpose?: FakePermit["purpose"];
		},
	): FakePermit => {
		const row: FakePermit = {
			purpose: "canary",
			...permit,
			state: "issued",
			settledCostUsd: 0,
			reservedEstimateUsd: 0,
		};
		permits.push(row);
		return row;
	};
	const setDispatch = (state: DispatchState) => {
		control.state = state;
	};
	return { deps, cases, attempts, calls, phasesProvider, permits, breakers, issuePermit, setDispatch };
}
