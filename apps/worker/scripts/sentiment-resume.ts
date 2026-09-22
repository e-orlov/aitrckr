/**
 * Verifier-only resumption of sentiment cases parked for review (Amendment C).
 *
 *   verify --dry-run --out <manifest.json>
 *       Selects by invariant, writes the manifest (ordered ids, count, digests,
 *       projected verify calls and the reservation planning estimate) and
 *       prints its sha256. Mutates nothing.
 *   verify --apply --manifest <manifest.json> --manifest-sha256 <hex> [--limit 10]
 *          --actor A --reason R --correlation C
 *       Recomputes the selection, refuses on any drift from the frozen
 *       manifest, authorizes one bounded batch with verify-only permits bound
 *       to the manifest's sha256 (issued, reused when this manifest's permit is
 *       still live, or replacing an expired unconsumed one) and sends the jobs.
 *       A failed send is reported per case and retried by repeating the same
 *       apply. Works under a held dispatch: the permits are the bypass.
 *
 * The reservation figure is a planning estimate, not a hard dollar ceiling;
 * the enforceable limits are one verify phase per case, the permit expiry and
 * the fencing. Exit codes: 0 ok · 1 error (incl. one or more failed sends) · 2 usage · 3 refused (drift).
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	applyResumeForVerify,
	ensureSentimentQueue,
	manifestSha256,
	RESUME_DEFAULT_BATCH,
	RESUME_MANIFEST_VERSION,
	type ResumeManifest,
	selectResumableForVerify,
} from "@workspace/lib/sentiment";
import boss from "../src/boss";

const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 } as const;
class UsageError extends Error {}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"dry-run": { type: "boolean", default: false },
		apply: { type: "boolean", default: false },
		out: { type: "string" },
		manifest: { type: "string" },
		"manifest-sha256": { type: "string" },
		limit: { type: "string" },
		actor: { type: "string" },
		reason: { type: "string" },
		correlation: { type: "string" },
	},
});

async function dryRun(): Promise<number> {
	if (!values.out) throw new UsageError("--dry-run needs --out <manifest.json>");
	const manifest = await selectResumableForVerify();
	const json = JSON.stringify(manifest, null, 2);
	await writeFile(values.out, json, "utf8");
	console.log(
		JSON.stringify({
			count: manifest.count,
			excluded: manifest.excluded.length,
			digest: manifest.digest,
			attemptDigest: manifest.attemptDigest,
			projected: manifest.projected,
			manifest: values.out,
			manifestSha256: manifestSha256(json),
		}),
	);
	return EXIT.ok;
}

async function apply(): Promise<number> {
	if (!values.manifest || !values["manifest-sha256"])
		throw new UsageError("--apply needs --manifest and --manifest-sha256");
	const json = await readFile(values.manifest, "utf8");
	if (manifestSha256(json) !== values["manifest-sha256"].toLowerCase())
		throw new UsageError("manifest sha256 does not match the file");
	const manifest = JSON.parse(json) as ResumeManifest;
	if (manifest.version !== RESUME_MANIFEST_VERSION)
		throw new UsageError(`manifest version ${manifest.version} is not ${RESUME_MANIFEST_VERSION}`);
	const limit = values.limit === undefined ? RESUME_DEFAULT_BATCH : Number.parseInt(values.limit, 10);
	if (!Number.isInteger(limit) || limit <= 0) throw new UsageError("--limit must be a positive integer");
	await boss.start();
	try {
		await ensureSentimentQueue(boss);
		const result = await applyResumeForVerify({
			manifest,
			manifestSha256: values["manifest-sha256"],
			limit,
			sender: boss,
			actor: values.actor ?? "",
			reason: values.reason ?? "",
			correlationId: values.correlation ?? "",
		});
		console.log(JSON.stringify(result));
		if (result.drift) return EXIT.refused;
		// A failed singleton send leaves its permit standing; the same manifest apply retries it — say so with the exit code.
		return result.failed.length > 0 ? EXIT.error : EXIT.ok;
	} finally {
		await boss.stop({ graceful: true, timeout: 10_000 });
	}
}

async function main(): Promise<number> {
	if (positionals[0] !== "verify") throw new UsageError('the only mode is "verify"');
	if (values["dry-run"] === values.apply) throw new UsageError("use exactly one of --dry-run or --apply");
	return values["dry-run"] ? dryRun() : apply();
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(error instanceof UsageError ? EXIT.usage : EXIT.error);
	},
);
