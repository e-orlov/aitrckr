/**
 * Operator surface for the sentiment dispatch safety controls (Amendment C).
 * Read-only unless a subcommand says otherwise; every mutating subcommand
 * requires --actor, --reason and --correlation and is safe to rerun (a repeat
 * finds the state already moved and is refused without writing).
 *
 *   status [--json]
 *   hold   --actor A --reason R --correlation C
 *   open   --actor A --reason R --correlation C --expected held
 *   breaker list [--json] | breaker reset <scope-key> … | breaker open <scope-key> --until-seconds N …
 *   permit list [--analysis <id>] [--live] [--json] | permit issue --run <id> --purpose canary
 *          --phases classify,repair,verify --estimated-budget 0.10 --ttl-seconds N [--contract-sha256 H] …
 *          | permit revoke <permit-id> …
 *   release-held --limit N [--dry-run] …
 *
 * Resume permits are never minted here: `resume:sentiment verify --apply` is
 * the only path, because it verifies the frozen manifest and the invariant
 * selector that a resume permit is bound to. "Live" always means a live state
 * and an expiry still ahead by the database clock; a stored row is shown with
 * its state and whether it is effective, never rewritten by a read.
 *
 * Money in this tool is an estimate: `estimated-budget` and the reservations
 * are planning figures, never a hard dollar ceiling. The enforceable limits
 * are the phases, the call count, the request token/tool limits, the expiry
 * and the fencing. Exit codes: 0 ok · 1 error · 2 usage · 3 refused ·
 * 10 (status only) dispatch is held.
 */
import { parseArgs } from "node:util";
import {
	analyzeAnswerRanges,
	candidatesFromMentions,
	ensureAnalysis,
	ensureResolutionCase,
	ensureSentimentQueue,
	isHeld,
	issuePermit,
	listBlockingBreakers,
	listBreakers,
	listControlEvents,
	listHeldWork,
	listPermits,
	loadDetectableEntities,
	loadMentions,
	loadRunForSentiment,
	openBreakerManually,
	PERMIT_PHASES,
	PERMIT_PURPOSES,
	type PermitPhase,
	type PermitPurpose,
	type PhaseBudget,
	readDispatchState,
	releaseHeldWork,
	resetBreaker,
	revokePermit,
	SENTIMENT_CLASSIFIER_VERSION,
	sentimentInputHash,
	transitionDispatch,
} from "@workspace/lib/sentiment";
import boss from "../src/boss";

const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 } as const;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		json: { type: "boolean", default: false },
		actor: { type: "string" },
		reason: { type: "string" },
		correlation: { type: "string" },
		expected: { type: "string" },
		analysis: { type: "string" },
		run: { type: "string" },
		purpose: { type: "string" },
		phases: { type: "string" },
		"estimated-budget": { type: "string" },
		"ttl-seconds": { type: "string" },
		"until-seconds": { type: "string" },
		"contract-sha256": { type: "string" },
		limit: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		live: { type: "boolean", default: false },
	},
});

const who = () => {
	if (!values.actor || !values.reason || !values.correlation)
		throw new UsageError("--actor, --reason and --correlation are required for a mutating command");
	return { actor: values.actor, reason: values.reason, correlationId: values.correlation };
};
const out = (value: unknown) => console.log(values.json ? JSON.stringify(value, null, 2) : JSON.stringify(value));
const positiveInt = (raw: string | undefined, flag: string): number => {
	const n = Number.parseInt(raw ?? "", 10);
	if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer`);
	return n;
};
class UsageError extends Error {}

async function status(): Promise<number> {
	const dispatch = await readDispatchState();
	const blocking = await listBlockingBreakers();
	// Effective permits only: live state and unexpired by the database clock.
	const live = await listPermits({ live: true });
	const held = await listHeldWork(10_000);
	const events = await listControlEvents("control", "dispatch");
	out({
		dispatch,
		lastTransition: events.at(-1)
			? {
					seq: events.at(-1)?.seq,
					toState: events.at(-1)?.toState,
					actor: events.at(-1)?.actor,
					at: events.at(-1)?.createdAt,
				}
			: null,
		breakers: {
			blocking: blocking.map((b) => ({
				scopeKey: b.scopeKey,
				state: b.state,
				openUntil: b.openUntil,
				openedClass: b.openedClass,
			})),
		},
		permits: { live: live.length, liveIds: live.map((p) => p.id) },
		heldWork: { pendingAnalyses: held.counts.a, receiptsWithoutAnalysis: held.counts.b },
		note: "estimated budgets and reservations are planning figures, not hard dollar ceilings",
	});
	return isHeld(dispatch) ? 10 : EXIT.ok;
}

async function move(to: "held" | "open"): Promise<number> {
	const expected = to === "open" ? values.expected : (values.expected ?? "open");
	if (to === "open" && expected !== "held") throw new UsageError("open requires --expected held");
	if (expected !== "held" && expected !== "open") throw new UsageError("--expected must be held or open");
	const result = await transitionDispatch({ to, expected, ...who() });
	out(result);
	return result.ok ? EXIT.ok : EXIT.refused;
}

async function breaker(): Promise<number> {
	const [, sub, scopeKey] = positionals;
	if (sub === "list" || sub === undefined) {
		out((await listBreakers()).map(({ requestProfile: _profile, ...row }) => row));
		return EXIT.ok;
	}
	if (!scopeKey) throw new UsageError("breaker reset|open needs a scope key");
	if (sub === "reset") {
		const result = await resetBreaker({ scopeKey, ...who() });
		out(result);
		return result.reset ? EXIT.ok : EXIT.refused;
	}
	if (sub === "open") {
		const result = await openBreakerManually({
			scopeKey,
			untilSeconds: positiveInt(values["until-seconds"], "--until-seconds"),
			...who(),
		});
		out(result);
		return result.opened ? EXIT.ok : EXIT.refused;
	}
	throw new UsageError("breaker subcommand must be list, reset or open (there is deliberately no force-close)");
}

function parsePhases(raw: string | undefined): PhaseBudget {
	const budget: PhaseBudget = { classify: 0, repair: 0, verify: 0 };
	for (const phase of (raw ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)) {
		if (!(PERMIT_PHASES as readonly string[]).includes(phase)) throw new UsageError(`unknown phase "${phase}"`);
		budget[phase as PermitPhase] = 1;
	}
	if (!Object.values(budget).some((v) => v === 1)) throw new UsageError("--phases must name at least one phase");
	return budget;
}

/** The exact current input of a run: its analysis row (created if needed) and the case instance the permit binds to. */
async function lifecycleOf(promptRunId: string) {
	const run = await loadRunForSentiment(promptRunId);
	if (!run || run.answerBody === null) throw new Error(`run ${promptRunId} has no extractable answer`);
	const analysis = await ensureAnalysis({ promptRunId: run.id, brandId: run.brandId });
	const candidates = candidatesFromMentions(
		await loadMentions(run.id),
		await loadDetectableEntities(run.brandId, "historical"),
	);
	if (candidates.length === 0) throw new Error(`run ${promptRunId} has no current mentions; nothing to classify`);
	const inputHash = sentimentInputHash(run.answerBody, candidates, analyzeAnswerRanges(run.answerBody));
	const kase = await ensureResolutionCase(analysis.id, inputHash);
	return { run, analysis, inputHash, instanceId: kase.instanceId };
}

async function permit(): Promise<number> {
	const [, sub, permitId] = positionals;
	if (sub === "list" || sub === undefined) {
		out(await listPermits({ analysisId: values.analysis, live: values.live }));
		return EXIT.ok;
	}
	if (sub === "revoke") {
		if (!permitId) throw new UsageError("permit revoke needs a permit id");
		const result = await revokePermit({ permitId, ...who() });
		out(result);
		return result.revoked ? EXIT.ok : EXIT.refused;
	}
	if (sub !== "issue") throw new UsageError("permit subcommand must be list, issue or revoke");
	if (!values.run) throw new UsageError("permit issue needs --run <prompt-run-id>");
	const purpose = values.purpose as PermitPurpose;
	if (!(PERMIT_PURPOSES as readonly string[]).includes(purpose))
		throw new UsageError("--purpose must be canary or resume-verify");
	if (purpose === "resume-verify") {
		throw new UsageError(
			"resume-verify permits are issued only by `resume:sentiment verify --apply` from a frozen manifest; this command cannot mint one",
		);
	}
	const budget = Number(values["estimated-budget"]);
	if (!Number.isFinite(budget) || budget <= 0)
		throw new UsageError("--estimated-budget must be a positive number (a planning estimate, not a cap)");
	const { run, analysis, inputHash, instanceId } = await lifecycleOf(values.run);
	const row = await issuePermit({
		purpose,
		promptRunId: run.id,
		analysisId: analysis.id,
		instanceId,
		inputHash,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		phaseBudget: parsePhases(values.phases),
		estimatedCostBudgetUsd: budget,
		ttlSeconds: positiveInt(values["ttl-seconds"], "--ttl-seconds"),
		contractSha256: values["contract-sha256"] ?? null,
		...who(),
	});
	out({
		...row,
		note: "estimated_cost_budget_usd is a planning estimate; hard limits are the phases, expiry and fencing",
	});
	return EXIT.ok;
}

async function releaseHeld(): Promise<number> {
	const limit = positiveInt(values.limit, "--limit");
	if (values["dry-run"]) {
		out(await releaseHeldWork({ limit, dryRun: true }));
		return EXIT.ok;
	}
	await boss.start();
	try {
		await ensureSentimentQueue(boss);
		out(await releaseHeldWork({ limit, dryRun: false, sender: boss, ...who() }));
	} finally {
		await boss.stop({ graceful: true, timeout: 10_000 });
	}
	return EXIT.ok;
}

async function main(): Promise<number> {
	switch (positionals[0]) {
		case "status":
			return status();
		case "hold":
			return move("held");
		case "open":
			return move("open");
		case "breaker":
			return breaker();
		case "permit":
			return permit();
		case "release-held":
			return releaseHeld();
		default:
			throw new UsageError("command must be status, hold, open, breaker, permit or release-held");
	}
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(error instanceof UsageError ? EXIT.usage : EXIT.error);
	},
);
