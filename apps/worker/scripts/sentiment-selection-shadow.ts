#!/usr/bin/env tsx
/**
 * SENT-01 classifier v4 read-selection shadow — for a restored copy only.
 * Reports which analysis the transitional read policy selects per run, adds
 * v4 fixture rows for a few runs (`--fixture <runId>` repeatable, `--fail
 * <runId>` for a failed v4 attempt), reports again, removes the fixtures and
 * reports a third time. Every mutation touches only the rows this script
 * inserted; the copy's own rows are never changed. Prints ids and counts only.
 *
 *   pnpm -C apps/worker exec tsx --env-file=<copy env> scripts/sentiment-selection-shadow.ts --fixture <run> [--fixture <run>] [--fail <run>]
 */
import { parseArgs } from "node:util";
import { db } from "@workspace/lib/db/db";
import { sentimentAnalyses, sentimentObservations } from "@workspace/lib/db/schema";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	selectedSentimentAnalyses,
} from "@workspace/lib/sentiment";
import { eq, inArray, sql } from "drizzle-orm";

async function snapshot(label: string) {
	const selected = await selectedSentimentAnalyses();
	const byVersion: Record<string, number> = {};
	for (const row of selected) byVersion[row.classifierVersion] = (byVersion[row.classifierVersion] ?? 0) + 1;
	const runs = new Set(selected.map((row) => row.promptRunId));
	const [{ observations }] = await db
		.select({ observations: sql<number>`count(*)::int` })
		.from(sentimentObservations)
		.where(
			inArray(
				sentimentObservations.analysisId,
				selected.map((row) => row.id),
			),
		);
	const [{ completedRows }] = await db
		.select({ completedRows: sql<number>`count(*)::int` })
		.from(sentimentAnalyses)
		.where(eq(sentimentAnalyses.status, "completed"));
	console.log(
		JSON.stringify({
			label,
			selectedAnalyses: selected.length,
			distinctRuns: runs.size,
			byVersion,
			observationsOfSelected: observations,
			completedRowsInTable: completedRows,
			doubleCounted: selected.length - runs.size,
		}),
	);
	return selected;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { fixture: { type: "string", multiple: true }, fail: { type: "string", multiple: true } },
	});
	const fixtures = values.fixture ?? [];
	const fails = values.fail ?? [];
	const before = await snapshot("before-v4-fixtures");
	const beforeByRun = new Map(before.map((row) => [row.promptRunId, row]));

	const inserted: string[] = [];
	for (const runId of [...fixtures, ...fails]) {
		const [existing] = await db
			.select({ brandId: sentimentAnalyses.brandId })
			.from(sentimentAnalyses)
			.where(eq(sentimentAnalyses.promptRunId, runId));
		if (!existing) throw new Error(`run ${runId} has no analysis row on this copy`);
		const [row] = await db
			.insert(sentimentAnalyses)
			.values({
				promptRunId: runId,
				brandId: existing.brandId,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
				status: fails.includes(runId) ? "failed" : "completed",
				completedAt: new Date(),
				errorCode: fails.includes(runId) ? "shadow-fixture" : null,
			})
			.returning({ id: sentimentAnalyses.id });
		inserted.push(row.id);
		if (!fails.includes(runId)) {
			// One observation per fixture so the selected-observation count moves with the selection.
			const [source] = await db
				.select({
					mentionId: sentimentObservations.mentionId,
					brandId: sentimentObservations.brandId,
					entityType: sentimentObservations.entityType,
					competitorId: sentimentObservations.competitorId,
					entityKey: sentimentObservations.entityKey,
				})
				.from(sentimentObservations)
				.where(eq(sentimentObservations.analysisId, beforeByRun.get(runId)?.id ?? ""));
			if (source) {
				await db.insert(sentimentObservations).values({
					analysisId: row.id,
					mentionId: source.mentionId,
					promptRunId: runId,
					brandId: source.brandId,
					entityType: source.entityType,
					competitorId: source.competitorId,
					entityKey: source.entityKey,
					score: 50,
					category: "neutral",
					confidence: "0.500",
					evidence: [],
				});
			}
		}
	}
	const during = await snapshot("with-v4-fixtures");
	const duringByRun = new Map(during.map((row) => [row.promptRunId, row]));
	const replaced = fixtures.filter(
		(runId) => duringByRun.get(runId)?.classifierVersion === SENTIMENT_CLASSIFIER_VERSION,
	);
	const keptOnFailure = fails.filter((runId) => duringByRun.get(runId)?.id === beforeByRun.get(runId)?.id);
	const untouched = [...beforeByRun.entries()].filter(
		([runId, row]) => !fixtures.includes(runId) && duringByRun.get(runId)?.id === row.id,
	).length;
	console.log(
		JSON.stringify({
			replacedByV4: replaced.length,
			expectedReplaced: fixtures.length,
			v3KeptUnderFailedV4: keptOnFailure.length,
			expectedKept: fails.length,
			otherRunsUntouched: untouched,
			expectedUntouched: before.length - fixtures.length,
		}),
	);

	await db.delete(sentimentObservations).where(inArray(sentimentObservations.analysisId, inserted));
	await db.delete(sentimentAnalyses).where(inArray(sentimentAnalyses.id, inserted));
	const after = await snapshot("after-removing-fixtures");
	const restored =
		after.length === before.length && after.every((row) => beforeByRun.get(row.promptRunId)?.id === row.id);
	console.log(JSON.stringify({ fallbackRestoredIdentically: restored }));
	process.exit(0);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
