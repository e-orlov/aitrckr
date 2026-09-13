// A fake canary child for the supervisor tests. It records what it manages to
// do as marker files so the parent can prove what did NOT happen after the
// kill. Modes:
//   accept  — prints an accepting report and exits 0
//   reject  — prints a rejecting report and exits 1
//   hang    — makes one "provider call", spawns a grandchild, ignores every
//             termination signal, and tries to make a second call and write a
//             late marker after `lateMs`
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, markerDir, lateArg] = process.argv.slice(2);
const lateMs = Number(lateArg ?? 1500);
mkdirSync(markerDir, { recursive: true });
const mark = (name, value = String(Date.now())) => writeFileSync(join(markerDir, name), value);

mark("started", String(process.pid));

if (mode === "accept" || mode === "reject") {
	process.stdout.write(`${JSON.stringify({ attempts: 1, verdict: { status: mode } })}\n`);
	process.exit(mode === "accept" ? 0 : 1);
}

if (mode === "grandchild") {
	// Outlives a killed parent unless the whole tree is killed.
	setTimeout(() => mark("grandchild-late"), lateMs);
} else {
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
		try {
			process.on(signal, () => mark(`ignored-${signal}`));
		} catch {}
	}
	mark("provider-call-1");
	const grandchild = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "grandchild", markerDir, String(lateMs)],
		{
			stdio: "ignore",
		},
	);
	mark("grandchild-pid", String(grandchild.pid));
	setTimeout(() => {
		mark("late-marker");
		mark("provider-call-2");
		process.stdout.write(`${JSON.stringify({ attempts: 2, verdict: { status: "accept" } })}\n`);
	}, lateMs);
	// Keep the event loop alive well past any watchdog under test.
	setTimeout(() => {}, lateMs * 20);
}
