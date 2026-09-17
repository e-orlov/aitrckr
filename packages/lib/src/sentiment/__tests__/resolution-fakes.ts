import type { Provider } from "../../providers/types";
import type { SentimentJobDeps } from "../job";
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

export function resolutionFakes(options: { verifierVerdict?: unknown; repairAnswer?: unknown } = {}) {
	const cases = new Map<string, Record<string, unknown>>();
	const attempts: {
		id: string;
		analysisId: string;
		instanceId: string;
		ordinal: number;
		phase: string;
		outcome: string;
		generationId: string | null;
		actualCostUsd: string | null;
		inputHash: string;
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
		openProviderAttempt: async ({ analysisId, phase, inputHash, claim }) => {
			const ordinal = attempts.filter((a) => a.analysisId === analysisId).length + 1;
			const row = {
				id: `att-${analysisId}-${ordinal}`,
				analysisId,
				instanceId: claim.instanceId,
				ordinal,
				phase,
				outcome: "sending",
				generationId: null,
				actualCostUsd: null,
				inputHash,
				startedAt: new Date(),
			};
			attempts.push(row);
			return { id: row.id, ordinal };
		},
		finishProviderAttempt: async (id, args) => {
			const row = attempts.find((a) => a.id === id);
			if (!row) return;
			row.outcome = args.outcome;
			row.generationId = args.generationId ?? null;
			row.actualCostUsd = typeof args.actualCostUsd === "number" ? args.actualCostUsd.toFixed(6) : null;
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
	return { deps, cases, attempts, calls, phasesProvider };
}
