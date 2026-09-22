import { and, eq, notExists } from "drizzle-orm";
import { db } from "../db/db";
import { sentimentAnalyses, sentimentDetections } from "../db/schema";
import {
	appendControlEvent,
	type ControlActor,
	DISPATCH_CONTROL_KEY,
	isHeld,
	readDispatchState,
	requireActor,
} from "./controls";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import { type Executor, ensureAnalysis } from "./store";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_DETECTOR_VERSION } from "./types";

/**
 * Work that arrived while dispatch was held, read from the rows the gates
 * left behind — no ledger of its own (Amendment C):
 *  A. a current-version analysis still `pending` with zero attempts — the
 *     natural enqueue gate, an execution gate that completed as held, or a
 *     send that failed after the row existed;
 *  B. a current-detector mentions receipt for a run with no analysis row of
 *     any version — a crash between the receipt and the analysis row.
 * Historical runs never appear: every mention-bearing historical run already
 * carries an analysis row of some version, and B requires none.
 */
export interface HeldWorkItem {
	promptRunId: string;
	brandId: string;
	analysisId: string | null;
	source: "A" | "B";
}

export async function listHeldWork(
	limit: number,
	executor: Executor = db,
): Promise<{ items: HeldWorkItem[]; counts: { a: number; b: number }; oldestAt: Date | null }> {
	const a = await executor
		.select({
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			id: sentimentAnalyses.id,
			since: sentimentAnalyses.createdAt,
		})
		.from(sentimentAnalyses)
		.where(
			and(
				eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
				eq(sentimentAnalyses.status, "pending"),
				eq(sentimentAnalyses.attempts, 0),
			),
		)
		.orderBy(sentimentAnalyses.createdAt, sentimentAnalyses.id);
	const b = await executor
		.select({
			promptRunId: sentimentDetections.promptRunId,
			brandId: sentimentDetections.brandId,
			since: sentimentDetections.detectedAt,
		})
		.from(sentimentDetections)
		.where(
			and(
				eq(sentimentDetections.detectorVersion, SENTIMENT_DETECTOR_VERSION),
				eq(sentimentDetections.status, "mentions"),
				notExists(
					executor
						.select({ id: sentimentAnalyses.id })
						.from(sentimentAnalyses)
						.where(eq(sentimentAnalyses.promptRunId, sentimentDetections.promptRunId)),
				),
			),
		)
		.orderBy(sentimentDetections.detectedAt, sentimentDetections.promptRunId);
	const items: HeldWorkItem[] = [
		...a.map((row) => ({
			promptRunId: row.promptRunId,
			brandId: row.brandId,
			analysisId: row.id,
			source: "A" as const,
		})),
		...b.map((row) => ({ promptRunId: row.promptRunId, brandId: row.brandId, analysisId: null, source: "B" as const })),
	];
	const oldestAt = [...a, ...b].reduce<Date | null>(
		(oldest, row) => (oldest === null || row.since.getTime() < oldest.getTime() ? row.since : oldest),
		null,
	);
	return { items: items.slice(0, limit), counts: { a: a.length, b: b.length }, oldestAt };
}

export interface HeldReleaseResult {
	held: boolean;
	dryRun: boolean;
	counts: { a: number; b: number };
	selected: number;
	accepted: number;
	deduplicated: number;
	failed: number;
	promptRunIds: string[];
}

/**
 * Bounded, explicit release of held work: refused while dispatch is held;
 * otherwise each selected run is sent through the same singleton-keyed send
 * every producer uses, so a run already queued or active is never duplicated
 * and a re-run only sends what is still pending. Never runs from maintenance.
 */
export async function releaseHeldWork(
	args: { limit: number; dryRun: boolean; sender?: SentimentSender } & Partial<ControlActor>,
	executor: Executor = db,
): Promise<HeldReleaseResult> {
	if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error("limit must be a positive integer");
	const state = await readDispatchState(executor);
	const { items, counts } = await listHeldWork(args.limit, executor);
	const base: HeldReleaseResult = {
		held: isHeld(state),
		dryRun: args.dryRun,
		counts,
		selected: items.length,
		accepted: 0,
		deduplicated: 0,
		failed: 0,
		promptRunIds: items.map((i) => i.promptRunId),
	};
	if (args.dryRun) return base;
	const who = requireActor(args);
	if (isHeld(state))
		throw new Error("sentiment dispatch is held; release-held is refused until an operator opens dispatch");
	if (!args.sender) throw new Error("release requires a queue sender");
	for (const item of items) {
		try {
			if (item.source === "B") await ensureAnalysis({ promptRunId: item.promptRunId, brandId: item.brandId }, executor);
			const jobId = await sendSentimentJob(args.sender, item.promptRunId);
			if (jobId === null) base.deduplicated += 1;
			else base.accepted += 1;
		} catch (error) {
			base.failed += 1;
			console.error(
				`held-work release failed for run ${item.promptRunId}:`,
				error instanceof Error ? error.name : typeof error,
			);
		}
	}
	await executor.transaction((tx) =>
		appendControlEvent(tx, {
			subjectKind: "control",
			subjectKey: `${DISPATCH_CONTROL_KEY}:release`,
			fromState: null,
			toState: "released",
			evidence: {
				selected: base.selected,
				accepted: base.accepted,
				deduplicated: base.deduplicated,
				failed: base.failed,
			},
			...who,
		}),
	);
	return base;
}
