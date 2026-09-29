import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export interface SuperviseOptions {
	command: string;
	args: string[];
	/** Hard limit for the child: when it passes, the whole process tree is killed. */
	watchdogMs: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Streamed copies of the child's output, for an operator watching the run. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	/** How long to wait for the exit event after the kill before giving up on it. */
	killGraceMs?: number;
}

export type SuperviseResult = {
	durationMs: number;
	stdout: string;
	stderr: string;
} & (
	| { status: "exited"; exitCode: number; signal: NodeJS.Signals | null }
	| {
			status: "killed";
			/** The kill command reported success; when false, something of the tree may survive. */
			treeKilled: boolean;
			/** The child's exit was observed after the kill. */
			exitObserved: boolean;
			exitCode: number | null;
			signal: NodeJS.Signals | null;
	  }
	| { status: "spawn-error"; errorName: string }
);

/**
 * Kill a child together with everything it spawned. Windows has no process
 * groups, so `taskkill /T` walks the tree; elsewhere the child is started as
 * a group leader (`detached`) and the whole group receives SIGKILL. Returns
 * whether the kill command itself succeeded.
 */
export function killProcessTree(child: ChildProcess): boolean {
	const pid = child.pid;
	if (pid === undefined) return false;
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		return child.kill("SIGKILL");
	}
}

/**
 * Run the canary in a child process under a hard watchdog. An in-process
 * deadline can only abort code that honours the signal; a process boundary
 * ends code that does not. When the watchdog fires the process tree is
 * killed, the result says so, and nothing of the canary is left running once
 * this resolves (unless `treeKilled` is false, which the caller must treat as
 * a failure too).
 */
export function superviseCanaryChild(options: SuperviseOptions): Promise<SuperviseResult> {
	const started = Date.now();
	const killGraceMs = options.killGraceMs ?? 5_000;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killed = false;
		let treeKilled = false;
		let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const later = (fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			timers.push(timer);
			return timer;
		};
		const settle = (result: SuperviseResult) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			resolve(result);
		};
		const base = () => ({ durationMs: Date.now() - started, stdout, stderr });

		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			options.onStdout?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			options.onStderr?.(text);
		});

		const settleKilled = () =>
			settle({
				...base(),
				status: "killed",
				treeKilled,
				exitObserved: exit !== null,
				exitCode: exit?.code ?? null,
				signal: exit?.signal ?? null,
			});

		const watchdog = later(() => {
			killed = true;
			treeKilled = killProcessTree(child);
			// The exit event normally follows within milliseconds; if it never
			// comes, report the kill anyway rather than hang here.
			later(settleKilled, killGraceMs);
		}, options.watchdogMs);

		child.on("error", (error) => {
			clearTimeout(watchdog);
			settle({ ...base(), status: "spawn-error", errorName: error.name });
		});
		child.on("exit", (code, signal) => {
			exit = { code, signal };
			clearTimeout(watchdog);
			// Give the stdio streams a moment to flush what the child wrote last.
			later(
				() => (killed ? settleKilled() : settle({ ...base(), status: "exited", exitCode: code ?? 1, signal })),
				500,
			);
		});
		child.on("close", () => {
			if (exit === null) return;
			if (killed) settleKilled();
			else settle({ ...base(), status: "exited", exitCode: exit.code ?? 1, signal: exit.signal });
		});
	});
}
