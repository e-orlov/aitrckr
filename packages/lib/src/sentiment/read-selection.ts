import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "../db/db";
import { sentimentAnalyses } from "../db/schema";
import { SENTIMENT_READABLE_CLASSIFIER_VERSIONS, SENTIMENT_TAXONOMY_VERSION } from "./types";

type Executor = typeof db;

/**
 * The one analysis every Sentiment read uses for a prompt run during the
 * v3 → v4 transition: the completed analysis of the most preferred readable
 * classifier version under the current taxonomy. Exactly one row per run is
 * selected, so no metric, series, leaderboard or evidence panel can count a
 * run twice or mix versions; a failed, pending or processing attempt of a newer
 * version never hides an older completed analysis; versions outside
 * `SENTIMENT_READABLE_CLASSIFIER_VERSIONS` are never read. Every read path
 * must go through this selection instead of filtering on a version constant.
 */
export function selectedSentimentAnalyses(executor: Executor = db) {
	return executor
		.selectDistinctOn([sentimentAnalyses.promptRunId], {
			id: sentimentAnalyses.id,
			promptRunId: sentimentAnalyses.promptRunId,
			classifierVersion: sentimentAnalyses.classifierVersion,
		})
		.from(sentimentAnalyses)
		.where(readableCompletedWhere())
		.orderBy(sentimentAnalyses.promptRunId, readablePreference());
}

/** `id IN (selected)` predicate for joins on `sentiment_analyses`. */
export function selectedSentimentAnalysisIds(executor: Executor = db): SQL {
	return inArray(
		sentimentAnalyses.id,
		executor
			.selectDistinctOn([sentimentAnalyses.promptRunId], { id: sentimentAnalyses.id })
			.from(sentimentAnalyses)
			.where(readableCompletedWhere())
			.orderBy(sentimentAnalyses.promptRunId, readablePreference()),
	) as SQL;
}

function readableCompletedWhere(): SQL {
	return and(
		eq(sentimentAnalyses.status, "completed"),
		eq(sentimentAnalyses.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
		inArray(sentimentAnalyses.classifierVersion, [...SENTIMENT_READABLE_CLASSIFIER_VERSIONS]),
	) as SQL;
}

/** Sort key: position of the row's version in the preference list (1 = current). */
function readablePreference(): SQL {
	const versions = sql.join(
		SENTIMENT_READABLE_CLASSIFIER_VERSIONS.map((version) => sql`${version}`),
		sql`, `,
	);
	return sql`array_position(ARRAY[${versions}]::text[], ${sentimentAnalyses.classifierVersion})`;
}

export type SentimentRunCoverageStatus = "completed" | "pending" | "failed" | "no_mentions";

/**
 * One coverage status per prompt run over all its analysis rows, consistent
 * with the selection above: `completed` when a readable completed analysis is
 * selected; otherwise `pending` while a readable attempt is in flight;
 * otherwise `failed` when the newest readable attempt failed; otherwise
 * `no_mentions`; rows of unreadable versions or a stale taxonomy alone are
 * stale work still to be redone and count as `pending`.
 */
export function sentimentRunCoverageStatus(): SQL<SentimentRunCoverageStatus> {
	const readable = inArray(sentimentAnalyses.classifierVersion, [...SENTIMENT_READABLE_CLASSIFIER_VERSIONS]);
	const completed = and(readableCompletedWhere());
	const inFlight = and(readable, inArray(sentimentAnalyses.status, ["pending", "processing"]));
	const failed = and(readable, eq(sentimentAnalyses.status, "failed"));
	const noMentions = and(readable, eq(sentimentAnalyses.status, "no_mentions"));
	return sql<SentimentRunCoverageStatus>`case
		when bool_or(${completed}) then 'completed'
		when bool_or(${inFlight}) then 'pending'
		when bool_or(${failed}) then 'failed'
		when bool_or(${noMentions}) then 'no_mentions'
		else 'pending' end`;
}
