// Reconcile the sentiment integration matrix run in CI: the vitest JSON report must cover exactly the integration files
// present on disk with a nonzero test count and zero failures, and the net-guard log must show only loopback targets.
// Prints the inventory so the job log carries it. Exits non-zero on any discrepancy.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const [reportPath, testsDir, guardLog] = process.argv.slice(2);
if (!reportPath || !testsDir || !guardLog) {
	console.error("usage: reconcile.cjs <vitest-json-report> <integration-tests-dir> <net-guard-log>");
	process.exit(2);
}

const failures = [];
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const onDisk = fs
	.readdirSync(testsDir)
	.filter((f) => f.endsWith(".integration.test.ts"))
	.sort();
const ran = [...new Set(report.testResults.map((r) => path.basename(r.name)))].sort();
console.log("Integration files on disk:");
for (const f of onDisk) console.log(`  ${f}`);
console.log(`Files executed: ${ran.length}, tests: ${report.numTotalTests}, passed: ${report.numPassedTests}, failed: ${report.numFailedTests}, pending: ${report.numPendingTests}`);
if (JSON.stringify(ran) !== JSON.stringify(onDisk)) {
	failures.push(`executed files differ from disk: ran=${JSON.stringify(ran)} disk=${JSON.stringify(onDisk)}`);
}
if (!(report.numTotalTests > 0)) failures.push("zero tests executed");
if (report.numFailedTests !== 0) failures.push(`${report.numFailedTests} failed tests`);
if (report.numPassedTests !== report.numTotalTests) failures.push("not every test passed");
for (const r of report.testResults) {
	console.log(`  ${path.basename(r.name)}: ${r.assertionResults.length} tests, ${r.status}`);
}

const lines = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8").split("\n") : [];
const connects = lines.filter((l) => l.includes(" connect tcp "));
const blocked = connects.filter((l) => l.endsWith(" BLOCK"));
const nonLoopback = connects.filter((l) => !/host=(?:localhost|127\.[0-9.]+|::1|0\.0\.0\.0|::) /.test(l));
const guardLoaded = lines.filter((l) => l.includes("guard-loaded")).length;
console.log(`Net guard: processes guarded=${guardLoaded}, tcp connects=${connects.length}, blocked=${blocked.length}, non-loopback=${nonLoopback.length}`);
if (guardLoaded === 0) failures.push("the net guard was never loaded");
if (blocked.length > 0 || nonLoopback.length > 0) failures.push(`non-loopback network activity: ${[...blocked, ...nonLoopback].join(" | ")}`);

if (failures.length > 0) {
	for (const f of failures) console.error(`RECONCILE FAIL: ${f}`);
	process.exit(1);
}
console.log("Sentiment integration matrix reconciled: every integration file ran, all tests passed, loopback only.");
