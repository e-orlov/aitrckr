/**
 * F-05 real-Postgres verification (F05-RC-003 / F05-RC-DB-001), run in CI's
 * Deployment Smoke Tests against the disposable service database after
 * migrations. Proves on a REAL PostgreSQL what mocked adapters cannot:
 *
 *   1. concurrent production `upsertSourceClassification` calls for one
 *      hostname all succeed and leave exactly one valid current-version row;
 *   2. the F-05 queue's effective policy is `exclusive`;
 *   3. concurrent `boss.send()` with one singleton key yield exactly one
 *      non-null job id, and at most one queued/retry/active job exists for
 *      that key.
 *
 * Deliberately NOT exercised: the worker handler, the classifier, and any LLM
 * call — none of those modules are imported here.
 *
 * Guard: refuses non-loopback databases unless ALLOW_REMOTE_DB=1 (same
 * convention as verify-membership-dedupe). Cleanup removes only the rows/jobs
 * this script created, and only inside that guarded database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm -C apps/worker exec tsx scripts/verify-source-classification-db.ts
 */
import {
	ensureSourceClassificationQueue,
	SOURCE_CLASSIFICATION_QUEUE,
	SOURCE_CLASSIFIER_VERSION,
	sourceClassificationSingletonKey,
	upsertSourceClassification,
} from "@workspace/lib/source-classification";
import { Client } from "pg";
import { PgBoss } from "pg-boss";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("DATABASE_URL is required");
	process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && process.env.ALLOW_REMOTE_DB !== "1") {
	console.error("Refusing to run against a non-local database (set ALLOW_REMOTE_DB=1 to override)");
	process.exit(2);
}

const HOSTNAME = "f05-db-verify.example.org";
const CONCURRENCY = 8;

function assert(condition: boolean, message: string): void {
	if (!condition) {
		console.error(`✗ ${message}`);
		process.exit(1);
	}
	console.log(`✓ ${message}`);
}

async function verifyConcurrentUpsert(client: Client): Promise<void> {
	await client.query("DELETE FROM source_domain_classifications WHERE hostname = $1", [HOSTNAME]);

	const results = await Promise.allSettled(
		Array.from({ length: CONCURRENCY }, (_, i) =>
			upsertSourceClassification({
				hostname: HOSTNAME,
				category: i % 2 === 0 ? "institutional" : "editorial",
				confidence: 0.5 + i / 100,
				reason: `concurrent upsert probe ${i}`,
				provider: "db-verify",
				model: `db-verify-model-${i}`,
				classifierVersion: SOURCE_CLASSIFIER_VERSION,
			}),
		),
	);
	const rejected = results.filter((r) => r.status === "rejected");
	assert(
		rejected.length === 0,
		`all ${CONCURRENCY} concurrent upserts succeed (${rejected.length} rejected${
			rejected.length ? `: ${String((rejected[0] as PromiseRejectedResult).reason)}` : ""
		})`,
	);

	const { rows } = await client.query(
		"SELECT category, confidence, reason, classifier_version FROM source_domain_classifications WHERE hostname = $1",
		[HOSTNAME],
	);
	assert(rows.length === 1, `exactly one row remains for the hostname (got ${rows.length})`);
	assert(rows[0].classifier_version === SOURCE_CLASSIFIER_VERSION, "the surviving row carries the current version");
	assert(
		["editorial", "institutional", "other"].includes(rows[0].category),
		`the surviving row is valid (category ${rows[0].category})`,
	);
	const confidence = Number(rows[0].confidence);
	assert(confidence >= 0 && confidence <= 1, `confidence within bounds (${confidence})`);

	await client.query("DELETE FROM source_domain_classifications WHERE hostname = $1", [HOSTNAME]);
}

async function verifyQueueDedupe(client: Client, boss: PgBoss): Promise<void> {
	await ensureSourceClassificationQueue(boss);

	const queue = await boss.getQueue(SOURCE_CLASSIFICATION_QUEUE);
	assert(queue?.policy === "exclusive", `queue policy is exclusive (got ${queue?.policy ?? "missing"})`);

	const singletonKey = sourceClassificationSingletonKey(HOSTNAME, SOURCE_CLASSIFIER_VERSION);
	const payload = { hostname: HOSTNAME, classifierVersion: SOURCE_CLASSIFIER_VERSION, builtInCategory: "other" };

	// Start clean in case an earlier run left the probe job behind.
	await client.query("DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2", [
		SOURCE_CLASSIFICATION_QUEUE,
		singletonKey,
	]);

	const ids = await Promise.all(
		Array.from({ length: CONCURRENCY }, () => boss.send(SOURCE_CLASSIFICATION_QUEUE, payload, { singletonKey })),
	);
	const accepted = ids.filter((id): id is string => id !== null);
	assert(
		accepted.length === 1,
		`exactly one of ${CONCURRENCY} concurrent same-key sends is accepted (got ${accepted.length})`,
	);

	const { rows } = await client.query(
		`SELECT count(*)::int AS count FROM pgboss.job
		 WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry', 'active')`,
		[SOURCE_CLASSIFICATION_QUEUE, singletonKey],
	);
	assert(rows[0].count === 1, `at most one queued/retry/active job exists for the key (got ${rows[0].count})`);

	// A follow-up send while the job is queued must also be deduplicated.
	const followUp = await boss.send(SOURCE_CLASSIFICATION_QUEUE, payload, { singletonKey });
	assert(followUp === null, "a later send with the same key is deduplicated (null id)");

	await boss.deleteJob(SOURCE_CLASSIFICATION_QUEUE, accepted[0]);
}

async function main(): Promise<void> {
	const client = new Client({ connectionString: DATABASE_URL });
	await client.connect();
	const boss = new PgBoss({ connectionString: DATABASE_URL, schema: "pgboss", supervise: false });
	try {
		await verifyConcurrentUpsert(client);
		await boss.start();
		await verifyQueueDedupe(client, boss);
	} finally {
		await boss.stop({ graceful: false, timeout: 5000 }).catch(() => {});
		await client.end();
	}
	console.log("\nSource classification DB verification PASSED (no worker handler, classifier, or LLM involved)");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
