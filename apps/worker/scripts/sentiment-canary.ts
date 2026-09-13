#!/usr/bin/env tsx
/**
 * SENT-01 paid canary driver — one bounded classifier call for one frozen run.
 *
 *   inspect <run-id>
 *       Read-only. Prints the run in contract form (ids, answer-body digest,
 *       the entity set the job would classify, locked versions/provider/model)
 *       so the operator can freeze it as the contract file. No answer text.
 *
 *   run --contract <file> <run-id>
 *       Supervises exactly one canary attempt in a child process: the child
 *       preflights the contract against the stored run (no request on any
 *       mismatch), makes one call with a 120 s request deadline and a 125 s
 *       in-process watchdog, and prints a safe report with a verdict; the
 *       parent kills the whole child tree after 130 s whatever the child is
 *       doing. Exit 0 only for an accepting verdict from a child that exited
 *       0. Nothing is enqueued, nothing is retried, nothing is re-sent: a
 *       failure ends here, and the next attempt needs a new authorization.
 *
 * Usage (from apps/worker; env loaded by tsx from the chosen env file):
 *   pnpm canary:sentiment inspect <run-id>
 *   pnpm canary:sentiment run --contract <file> <run-id>
 *
 * The contract file stays outside Git: it names a production run, prompt and
 * competitor ids. Never carries a credential.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	acceptCanaryRunId,
	inspectSentimentCanaryRun,
	parseSentimentCanaryContract,
	runSentimentCanary,
	SENTIMENT_CANARY_DEADLINE_MS,
	SENTIMENT_CANARY_WATCHDOG_MS,
	type SentimentCanaryContract,
	SentimentCanaryError,
} from "@workspace/lib/sentiment";
import { superviseCanaryChild } from "../src/sentiment-canary-supervisor";

/** The in-process watchdog fires first; the supervisor's hard kill is the backstop. */
const IN_PROCESS_WATCHDOG_MS = SENTIMENT_CANARY_WATCHDOG_MS - 5_000;

const EXIT = { accept: 0, reject: 1, usage: 2, refused: 3 } as const;

function usage(message?: string): never {
	if (message) console.error(message);
	console.error(
		[
			"usage:",
			"  sentiment-canary inspect <run-id>",
			"  sentiment-canary run --contract <file> <run-id>",
			"Do not put `--` before the mode: pnpm forwards it literally.",
		].join("\n"),
	);
	process.exit(EXIT.usage);
}

function loadContract(path: string | undefined, runIdArgs: string[]): SentimentCanaryContract {
	if (!path) usage("--contract <file> is required");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`contract file unreadable: ${error instanceof Error ? error.name : typeof error}`);
		process.exit(EXIT.refused);
	}
	try {
		const contract = parseSentimentCanaryContract(raw);
		acceptCanaryRunId(runIdArgs, contract.runId);
		return contract;
	} catch (error) {
		if (error instanceof SentimentCanaryError) {
			console.error(`refused: ${error.code}`);
			process.exit(EXIT.refused);
		}
		throw error;
	}
}

async function main(): Promise<never> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		strict: true,
		options: {
			contract: { type: "string" },
			child: { type: "boolean", default: false },
		},
	});
	const [mode, ...rest] = positionals;
	if (rest.some((arg) => arg.startsWith("-")))
		usage(`unexpected argument "${rest.find((arg) => arg.startsWith("-"))}"`);

	if (mode === "inspect") {
		if (rest.length !== 1) usage("inspect takes exactly one run id");
		const description = await inspectSentimentCanaryRun(rest[0]);
		if (!description) {
			console.error("run not found");
			process.exit(EXIT.refused);
		}
		console.log(JSON.stringify(description, null, 2));
		process.exit(0);
	}

	if (mode !== "run") usage(mode ? `unknown mode "${mode}"` : undefined);
	const contract = loadContract(values.contract, rest);

	if (values.child) {
		// The attempt itself. `process.exit` is deliberate: the database pool and
		// any provider socket must not keep a finished canary alive.
		const report = await runSentimentCanary({
			contract,
			deadlineMs: SENTIMENT_CANARY_DEADLINE_MS,
			watchdogMs: IN_PROCESS_WATCHDOG_MS,
		});
		console.log(JSON.stringify(report));
		process.exit(report.verdict.status === "accept" ? EXIT.accept : EXIT.reject);
	}

	// The supervisor: same runtime (node + tsx loader flags), same env, same
	// script in child mode, one hard watchdog over the process tree.
	const result = await superviseCanaryChild({
		command: process.execPath,
		args: [
			...process.execArgv,
			process.argv[1],
			"run",
			"--contract",
			values.contract as string,
			contract.runId,
			"--child",
		],
		watchdogMs: SENTIMENT_CANARY_WATCHDOG_MS,
		cwd: process.cwd(),
		env: process.env,
		onStdout: (chunk) => process.stdout.write(chunk),
		onStderr: (chunk) => process.stderr.write(chunk),
	});

	const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
	let verdict: string | null = null;
	try {
		const parsed = JSON.parse(lastLine) as { verdict?: { status?: unknown } };
		verdict = typeof parsed.verdict?.status === "string" ? parsed.verdict.status : null;
	} catch {
		verdict = null;
	}
	const accepted = result.status === "exited" && result.exitCode === 0 && verdict === "accept";
	console.log(
		JSON.stringify({
			supervisor: {
				status: result.status,
				exitCode: "exitCode" in result ? result.exitCode : null,
				treeKilled: result.status === "killed" ? result.treeKilled : null,
				durationMs: result.durationMs,
				watchdogMs: SENTIMENT_CANARY_WATCHDOG_MS,
				childVerdict: verdict,
				accepted,
			},
		}),
	);
	process.exit(accepted ? EXIT.accept : EXIT.reject);
}

main().catch((error: unknown) => {
	console.error(`canary driver failed: ${error instanceof Error ? error.name : typeof error}`);
	process.exit(EXIT.reject);
});
