#!/usr/bin/env tsx
/**
 * SENT-ATTR-01 — re-anchor stored sentiment evidence under the current
 * evidence contract (table rows cell by cell).
 *
 *   plan [--brand <id>] --out <manifest.json>
 *       Read-only. For every completed current-version analysis, every parked
 *       current-version case and every older-version row the page still reads,
 *       derives what it becomes: current · restamp (identical result, stale
 *       hash) · reverify / repair (narrowed candidate seeded into a fresh
 *       resolution instance) · reclassify (nothing carried over) · enqueue
 *       (parked case of another input) · none. Prints the totals and the
 *       manifest's sha256. Mutates nothing.
 *   apply --manifest <f> --manifest-sha256 <hex> [--limit N] [--actions restamp,reverify,...] [--enqueue] --actor A --reason R
 *       Re-derives every entry from the live rows and refuses on drift. A
 *       restamp moves only the input hash; every other action rotates the
 *       resolution case and, with --enqueue, sends the classify-sentiment job
 *       the worker completes (verify / repair / classify + persist). Without
 *       --enqueue the rotation is written and the job can be sent by repeating
 *       the same apply. No provider call ever happens in this process.
 *   status --manifest <f>
 *       Read-only: what the worker has done with each planned analysis, with
 *       the calls and cost of the rotated instances.
 *
 * Exit codes: 0 ok · 1 error · 2 usage · 3 refused (manifest digest or dispatch).
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	applyReanchorEntry,
	buildReanchorManifest,
	ensureSentimentQueue,
	isHeld,
	REANCHOR_MANIFEST_VERSION,
	type ReanchorManifest,
	readDispatchState,
	reanchorManifestDigest,
	reanchorStatus,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_EVIDENCE_VERSION,
} from "@workspace/lib/sentiment";
import boss from "../src/boss";

const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 } as const;

function usage(message: string): never {
	console.error(message);
	process.exit(EXIT.usage);
}

async function loadManifest(path: string | undefined, expectedSha: string | undefined, verify: boolean) {
	if (!path) usage("--manifest <file> is required");
	const text = await readFile(path, "utf8");
	const manifest = JSON.parse(text) as ReanchorManifest;
	if (manifest.version !== REANCHOR_MANIFEST_VERSION)
		usage(`manifest version ${manifest.version} is not ${REANCHOR_MANIFEST_VERSION}`);
	if (verify) {
		if (!expectedSha) usage("--manifest-sha256 <hex> is required for apply");
		const actual = reanchorManifestDigest(manifest);
		if (actual !== expectedSha) {
			console.error(`manifest sha256 ${actual} does not match --manifest-sha256 ${expectedSha}`);
			process.exit(EXIT.refused);
		}
	}
	return manifest;
}

async function plan(values: { brand?: string; out?: string }): Promise<void> {
	if (!values.out) usage("plan requires --out <manifest.json>");
	const manifest = await buildReanchorManifest({ brandId: values.brand });
	await writeFile(values.out, `${JSON.stringify(manifest, null, 1)}\n`);
	console.log(
		JSON.stringify(
			{
				mode: "PLAN",
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				evidenceVersion: SENTIMENT_EVIDENCE_VERSION,
				entries: manifest.entries.length,
				totals: manifest.totals,
				manifest: values.out,
				manifestSha256: reanchorManifestDigest(manifest),
			},
			null,
			2,
		),
	);
	console.log("Dry run: nothing written, no provider call.");
}

interface ApplyValues {
	manifest?: string;
	"manifest-sha256"?: string;
	limit?: string;
	actions?: string;
	enqueue: boolean;
	actor?: string;
	reason?: string;
}

function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const limit = Number.parseInt(raw, 10);
	if (!Number.isInteger(limit) || limit <= 0) usage("--limit must be a positive integer");
	return limit;
}

/** The sender for --enqueue, or null; refuses under a held dispatch, where a sent job would only be gated. */
async function senderFor(enqueue: boolean) {
	if (!enqueue) return null;
	if (isHeld(await readDispatchState())) {
		console.error("dispatch is held: a sent job would be gated; open dispatch or run without --enqueue");
		process.exit(EXIT.refused);
	}
	await boss.start();
	await ensureSentimentQueue(boss);
	return boss;
}

async function apply(values: ApplyValues): Promise<number> {
	if (!values.actor || !values.reason) usage("apply requires --actor and --reason");
	const manifest = await loadManifest(values.manifest, values["manifest-sha256"], true);
	const limit = parseLimit(values.limit);
	const actions = new Set((values.actions ?? "restamp,reverify,repair,reclassify,enqueue").split(","));
	const sender = await senderFor(values.enqueue);
	console.log(
		JSON.stringify({
			mode: "APPLY",
			actor: values.actor,
			reason: values.reason,
			manifestSha256: values["manifest-sha256"],
			limit: limit ?? null,
			actions: [...actions],
			enqueue: values.enqueue,
		}),
	);
	const counts: Record<string, number> = {};
	let acted = 0;
	for (const entry of manifest.entries) {
		if (!actions.has(entry.action)) continue;
		if (limit !== undefined && acted >= limit) break;
		const outcome = await applyReanchorEntry(entry, sender);
		if (outcome.outcome !== "skipped") acted += 1;
		counts[outcome.outcome] = (counts[outcome.outcome] ?? 0) + 1;
		console.log(
			JSON.stringify({ ...outcome, promptRunId: entry.promptRunId, action: entry.action, scope: entry.scope }),
		);
	}
	if (sender) await sender.stop({ graceful: true, timeout: 10_000 });
	console.log(JSON.stringify({ mode: "APPLY", acted, counts }, null, 2));
	return EXIT.ok;
}

async function status(values: { manifest?: string }): Promise<void> {
	const manifest = await loadManifest(values.manifest, undefined, false);
	const rows = await reanchorStatus(manifest);
	const summary: Record<string, number> = {};
	let calls = 0;
	let costUsd = 0;
	for (const row of rows) {
		const key = `${row.plannedAction}:${row.analysisStatus}:${row.current ? "current" : "stale"}:${row.caseStatus ?? "-"}`;
		summary[key] = (summary[key] ?? 0) + 1;
		if (row.caseForCurrentInput) {
			calls += row.calls;
			costUsd += row.costUsd;
		}
	}
	console.log(
		JSON.stringify(
			{ mode: "STATUS", entries: rows.length, summary, currentInstances: { calls, costUsd: costUsd.toFixed(6) }, rows },
			null,
			1,
		),
	);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			brand: { type: "string" },
			out: { type: "string" },
			manifest: { type: "string" },
			"manifest-sha256": { type: "string" },
			limit: { type: "string" },
			actions: { type: "string" },
			enqueue: { type: "boolean", default: false },
			actor: { type: "string" },
			reason: { type: "string" },
		},
	});
	if (positionals.length !== 1)
		usage(`expected exactly one mode (plan | apply | status), got ${JSON.stringify(positionals)}`);
	switch (positionals[0]) {
		case "plan":
			await plan(values);
			process.exit(EXIT.ok);
			break;
		case "apply":
			process.exit(await apply(values));
			break;
		case "status":
			await status(values);
			process.exit(EXIT.ok);
			break;
		default:
			usage(`unknown mode ${positionals[0]}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(EXIT.error);
});
