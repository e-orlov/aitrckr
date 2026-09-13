#!/usr/bin/env tsx
/**
 * SENT-01 backfill — two safe mechanisms over ALL stored prompt runs (every
 * prompt, enabled or not), oldest first, in bounded keyset pages with an
 * opaque resume token.
 *
 *   mentions   Deterministic entity-mention detection/repair. No provider
 *              call. Dry run by default; `--apply` writes current-version
 *              mention rows. Reports matched/ambiguous/orphan legacy names,
 *              unextractable runs, already-current rows and rows to write.
 *
 *   sentiment  Paid-work inventory. Dry run by default; `--enqueue` requires
 *              an explicit positive `--limit N` and counts ACCEPTED jobs only
 *              (deduplicated sends do not consume the limit). No LLM call ever
 *              happens in this process — the worker performs them one at a
 *              time under the exclusive queue.
 *
 * Usage:
 *   pnpm -C apps/worker backfill:sentiment mentions            # inventory
 *   pnpm -C apps/worker backfill:sentiment mentions --apply    # write rows
 *   pnpm -C apps/worker backfill:sentiment sentiment           # inventory
 *   pnpm -C apps/worker backfill:sentiment sentiment --enqueue --limit 5
 *   … --brand <id> --cursor <token> --max-pages <n> --page-size <n>
 *
 * Do not put `--` before the mode: pnpm forwards it literally and everything
 * after it would be read as positional text instead of flags (refused below).
 *
 * Repeated dry runs on unchanged data print identical counts.
 */
import { parseArgs } from "node:util";
import {
	decodeRunCursor,
	ensureSentimentQueue,
	runMentionBackfill,
	runSentimentEnqueue,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
} from "@workspace/lib/sentiment";
import boss from "../src/boss";

function positiveInt(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
	return value;
}

interface CommonArgs {
	brandId?: string;
	cursor: ReturnType<typeof decodeRunCursor>;
	maxPages?: number;
	pageSize?: number;
}

type Values = {
	apply: boolean;
	enqueue: boolean;
	limit?: string;
	brand?: string;
	cursor?: string;
	"max-pages"?: string;
	"page-size"?: string;
};

async function runMentionsMode(values: Values, common: CommonArgs): Promise<void> {
	if (values.enqueue || values.limit) throw new Error("--enqueue/--limit apply to the sentiment mode only");
	const label = values.apply ? "APPLY" : "DRY RUN";
	console.log(`SENT-01 mention backfill (${label}) — detector ${SENTIMENT_DETECTOR_VERSION}`);
	const result = await runMentionBackfill({ ...common, apply: values.apply });
	console.log(
		JSON.stringify({ mode: label, ...result.counts, nextCursor: result.partial ? result.nextCursor : null }, null, 2),
	);
	if (!values.apply) console.log("Dry run: no rows written, no provider calls made.");
	if (result.partial) console.log(`Partial scan: resume with --cursor "${result.nextCursor}".`);
}

async function runSentimentMode(values: Values, common: CommonArgs): Promise<void> {
	if (values.apply) throw new Error("--apply applies to the mentions mode only");
	const limit = positiveInt(values.limit, "--limit");
	if (values.enqueue && limit === undefined) throw new Error("--enqueue requires --limit N (positive integer)");
	if (!values.enqueue && limit !== undefined) throw new Error("--limit only applies together with --enqueue");

	if (values.enqueue) {
		await boss.start();
		await ensureSentimentQueue(boss);
	}
	const label = values.enqueue ? "ENQUEUE" : "DRY RUN";
	console.log(
		`SENT-01 sentiment backfill (${label}) — classifier ${SENTIMENT_CLASSIFIER_VERSION}, taxonomy ${SENTIMENT_TAXONOMY_VERSION}`,
	);
	const result = await runSentimentEnqueue({
		...common,
		enqueue: values.enqueue && limit !== undefined ? { limit } : false,
		sender: values.enqueue ? boss : undefined,
	});
	if (values.enqueue) await boss.stop({ graceful: true, timeout: 10_000 });
	console.log(
		JSON.stringify(
			{
				mode: label,
				...result.counts,
				limit: limit ?? null,
				limitReached: result.limitReached,
				nextCursor: result.partial ? result.nextCursor : null,
			},
			null,
			2,
		),
	);
	if (!values.enqueue) console.log("Dry run: no jobs enqueued, no rows written, no LLM calls made.");
	if (result.partial) console.log(`Partial scan: resume with --cursor "${result.nextCursor}".`);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			apply: { type: "boolean", default: false },
			enqueue: { type: "boolean", default: false },
			limit: { type: "string" },
			brand: { type: "string" },
			cursor: { type: "string" },
			"max-pages": { type: "string" },
			"page-size": { type: "string" },
		},
	});
	const common: CommonArgs = {
		brandId: values.brand,
		cursor: values.cursor === undefined ? null : decodeRunCursor(values.cursor),
		maxPages: positiveInt(values["max-pages"], "--max-pages"),
		pageSize: positiveInt(values["page-size"], "--page-size"),
	};
	if (positionals.length !== 1) {
		throw new Error(
			`expected exactly one mode argument, got ${JSON.stringify(positionals)} — drop any "--" before the mode`,
		);
	}
	switch (positionals[0]) {
		case "mentions":
			return runMentionsMode(values, common);
		case "sentiment":
			return runSentimentMode(values, common);
		default:
			throw new Error('first argument must be "mentions" or "sentiment"');
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
