#!/usr/bin/env tsx
/**
 * SENT-01 paid canary driver — one bounded classifier call for one frozen run.
 *
 *   inspect <run-id>
 *       Read-only. Prints the run in contract form (ids, answer-body digest,
 *       the canonical entity set the job would classify, the classifier-input
 *       and outbound-prompt digests, locked versions/provider/model) to stdout
 *       so the operator can freeze it as the contract file; the run's current
 *       analysis state (must be pristine before a paid attempt) goes to
 *       stderr. No answer text.
 *
 *   run --contract <file> --contract-sha256 <64-hex> <run-id>
 *       Supervises exactly one canary attempt in a child process. The
 *       contract file is accepted only when its raw bytes hash to the given
 *       digest — checked by the supervisor before the child starts and again
 *       by the child before it touches the database. The child preflights the
 *       contract against the stored run (no request on any mismatch), makes
 *       one call with a 120 s request deadline and a 125 s in-process
 *       watchdog, decides the post-call contract before anything is written,
 *       and prints a safe report with a verdict; the supervisor kills the
 *       whole child tree after 130 s whatever the child is doing. Exit 0 only
 *       for an accepting verdict from a child that exited 0. Nothing is
 *       enqueued, nothing is retried, nothing is re-sent.
 *
 *       Child mode is internal: the child runs only with the one-time token
 *       its supervisor issued, so the attempt cannot run outside the watchdog.
 *
 * Exit codes: 0 accept · 1 reject/failure · 2 usage · 3 refused before any work.
 *
 * Usage (from apps/worker; env loaded by tsx from the chosen env file):
 *   pnpm canary:sentiment inspect <run-id>
 *   pnpm canary:sentiment run --contract <file> --contract-sha256 <hex> <run-id>
 *
 * The contract file stays outside Git: it names a production run, prompt and
 * competitor ids. Never carries a credential.
 */
import { parseArgs } from "node:util";
import {
	acceptCanaryRunId,
	inspectSentimentCanaryRun,
	inspectSentimentCanaryRunState,
	parseSentimentCanaryContract,
	runSentimentCanary,
	SENTIMENT_CANARY_DEADLINE_MS,
	SENTIMENT_CANARY_WATCHDOG_MS,
	type SentimentCanaryContract,
	SentimentCanaryError,
} from "@workspace/lib/sentiment";
import {
	CanaryGuardError,
	CHILD_SECRET_ENV,
	issueChildToken,
	normalizeExpectedSha256,
	readVerifiedContractFile,
	verifyChildToken,
} from "../src/sentiment-canary-guard";
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
			"  sentiment-canary run --contract <file> --contract-sha256 <64-hex> <run-id>",
			"Do not put `--` before the mode: pnpm forwards it literally.",
		].join("\n"),
	);
	process.exit(EXIT.usage);
}

function refused(code: string): never {
	console.error(`refused: ${code}`);
	process.exit(EXIT.refused);
}

/** Contract file verified against the authorized digest, parsed, and bound to the single run id argument. */
function loadContract(path: string | undefined, expectedSha256: string | undefined, runIdArgs: string[]) {
	if (!path) usage("--contract <file> is required");
	if (!expectedSha256) usage("--contract-sha256 <64-hex> is required");
	try {
		const { raw, sha256 } = readVerifiedContractFile(path, expectedSha256);
		const contract = parseSentimentCanaryContract(raw);
		acceptCanaryRunId(runIdArgs, contract.runId);
		return { contract, sha256 };
	} catch (error) {
		if (error instanceof CanaryGuardError || error instanceof SentimentCanaryError) refused(error.code);
		throw error;
	}
}

async function runChild(contract: SentimentCanaryContract): Promise<never> {
	// `process.exit` is deliberate: the database pool and any provider socket
	// must not keep a finished canary alive.
	const report = await runSentimentCanary({
		contract,
		deadlineMs: SENTIMENT_CANARY_DEADLINE_MS,
		watchdogMs: IN_PROCESS_WATCHDOG_MS,
	});
	console.log(JSON.stringify(report));
	process.exit(report.verdict.status === "accept" ? EXIT.accept : EXIT.reject);
}

async function supervise(contractPath: string, contractSha256: string, runId: string): Promise<never> {
	const token = issueChildToken();
	// Same runtime (node + tsx loader flags), same env plus the one-time
	// secret, same script in child mode, one hard watchdog over the tree.
	const result = await superviseCanaryChild({
		command: process.execPath,
		args: [
			...process.execArgv,
			process.argv[1],
			"run",
			"--contract",
			contractPath,
			"--contract-sha256",
			contractSha256,
			runId,
			"--child",
			token.proof,
		],
		watchdogMs: SENTIMENT_CANARY_WATCHDOG_MS,
		cwd: process.cwd(),
		env: { ...process.env, [CHILD_SECRET_ENV]: token.secret },
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
				contractSha256,
				childVerdict: verdict,
				accepted,
			},
		}),
	);
	process.exit(accepted ? EXIT.accept : EXIT.reject);
}

function parseCli(args: string[]) {
	return parseArgs({
		args,
		allowPositionals: true,
		strict: true,
		options: {
			contract: { type: "string" },
			"contract-sha256": { type: "string" },
			child: { type: "string" },
		},
	});
}

async function main(): Promise<never> {
	let parsed: ReturnType<typeof parseCli>;
	try {
		parsed = parseCli(process.argv.slice(2));
	} catch (error) {
		usage(error instanceof Error ? error.message : "invalid arguments");
	}
	const { values, positionals } = parsed;
	const [mode, ...rest] = positionals;
	if (rest.some((arg) => arg.startsWith("-")))
		usage(`unexpected argument "${rest.find((arg) => arg.startsWith("-"))}"`);

	if (mode === "inspect") {
		if (values.child !== undefined || values.contract !== undefined) usage("inspect takes only a run id");
		if (rest.length !== 1) usage("inspect takes exactly one run id");
		const description = await inspectSentimentCanaryRun(rest[0]);
		if (!description) refused("run-not-found");
		// stdout is the contract, byte for byte; the run's current state goes
		// to stderr so it can be recorded without ever entering the contract.
		console.log(JSON.stringify(description, null, 2));
		console.error(JSON.stringify({ runState: await inspectSentimentCanaryRunState(rest[0]) }));
		process.exit(0);
	}

	if (mode !== "run") usage(mode ? `unknown mode "${mode}"` : undefined);

	if (values.child !== undefined) {
		// Internal child mode: refuse before anything else unless this process
		// was started by the supervisor holding the matching secret.
		const secret = process.env[CHILD_SECRET_ENV];
		delete process.env[CHILD_SECRET_ENV];
		if (!verifyChildToken(secret, values.child)) refused("child-token");
		const { contract } = loadContract(values.contract, values["contract-sha256"], rest);
		return runChild(contract);
	}

	const { contract, sha256 } = loadContract(values.contract, values["contract-sha256"], rest);
	return supervise(values.contract as string, normalizeExpectedSha256(sha256), contract.runId);
}

main().catch((error: unknown) => {
	console.error(`canary driver failed: ${error instanceof Error ? error.name : typeof error}`);
	process.exit(EXIT.reject);
});
