import { categorizeDomain } from "../citations/domain-categories.server";
import { normalizeSourceHostname } from "./hostname";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

export interface BackfillBrandContext {
	brandDomains: Set<string>;
	competitorDomains: Set<string>;
}

/**
 * The ordering key the citation scan sorts and groups by: a cheap normalization
 * (lowercase, trailing dots and one leading `www.` stripped) that makes every
 * raw-domain variant of one logical hostname CONTIGUOUS in the scan. That
 * contiguity is what lets the runner aggregate a logical hostname in a single
 * carry-over buffer instead of a table-sized seen-set. The SQL side must order
 * by the equivalent expression:
 *   regexp_replace(regexp_replace(lower(domain), '[.]+$', ''), '^www[.]', '')
 */
export function backfillOrderingKey(domain: string): string {
	return domain
		.toLowerCase()
		.replace(/\.+$/, "")
		.replace(/^www\./, "");
}

/**
 * Resume position: the last row of the last fully settled hostname group, in
 * the scan's (key, domain, brandId) order. Never points past a hostname that
 * was not yet sent or provably processed.
 */
export interface BackfillCursor {
	key: string;
	domain: string;
	brandId: string;
}

export interface BackfillCitationPageRow {
	/** `backfillOrderingKey(domain)` — computed by the source's SQL/ordering. */
	key: string;
	domain: string;
	brandId: string;
	/** Citations behind this (domain, brand) pair. */
	citationCount: number;
}

export interface BackfillCitationPage {
	/** Rows ordered by (key, domain, brandId) ascending. */
	rows: BackfillCitationPageRow[];
	/** Cursor of the last row when more data may follow, else null. */
	nextCursor: BackfillCursor | null;
}

/**
 * The bounded I/O the paged backfill needs. Each call must be bounded by its
 * arguments: one citation page of at most `batchSize` grouped rows, and cache
 * versions for one explicit hostname list.
 */
export interface BackfillPagedSource {
	fetchCitationPage(cursor: BackfillCursor | null, batchSize: number): Promise<BackfillCitationPage>;
	fetchCachedVersions(hostnames: string[]): Promise<Map<string, string>>;
}

/**
 * Hostname-level counters, incremented ONLY when a hostname group is settled.
 * Because every group settles exactly once across a resume sequence, summing
 * these counters over the sequence equals one uninterrupted full scan.
 */
export interface BackfillInventory {
	scannedCitations: number;
	distinctHostnames: number;
	invalid: number;
	brandOrCompetitorSkipped: number;
	deterministicSkipped: number;
	cachedCurrentSkipped: number;
	staleCached: number;
	eligible: number;
	/** Pages read by THIS run (mechanical, not part of the settle-once contract). */
	pagesScanned: number;
	/** True when unprocessed data remains; resume from `nextCursor`. */
	partial: boolean;
}

export interface BackfillRunResult {
	inventory: BackfillInventory;
	/** Resume point when `inventory.partial`; null when the scan completed. */
	nextCursor: BackfillCursor | null;
	/** Per-run send counters (mechanical): attempts made by THIS run. */
	attempted: number;
	/** Sends pg-boss accepted (non-null job id). */
	accepted: number;
	/** Sends deduplicated by the exclusive queue policy (null job id). */
	deduplicated: number;
	/** Sends that threw; the failing hostname stays AFTER `nextCursor` for retry. */
	failed: number;
	/**
	 * Bounded-state evidence: the most hostname groups this run ever held in
	 * memory at once. By construction ≤ batchSize + 1, independent of how many
	 * distinct domains the citations table contains.
	 */
	peakPendingGroups: number;
}

/** Hard ceiling on a citation page so no run can ask for an unbounded scan. */
export const BACKFILL_MAX_BATCH_SIZE = 20_000;
export const BACKFILL_DEFAULT_BATCH_SIZE = 5_000;

export interface BackfillRunArgs {
	source: BackfillPagedSource;
	brandContexts: Map<string, BackfillBrandContext>;
	batchSize?: number;
	maxPages?: number;
	cursor?: BackfillCursor | null;
	classifierVersion?: string;
	enqueue?: { send: (hostname: string) => Promise<string | null>; limit: number } | null;
}

export async function runSourceClassificationBackfill(args: BackfillRunArgs): Promise<BackfillRunResult> {
	if (args.enqueue && (!Number.isInteger(args.enqueue.limit) || args.enqueue.limit <= 0)) {
		throw new Error("enqueue mode requires an explicit positive integer limit");
	}
	return new BackfillScan(args).run();
}

/** One logical hostname's aggregate: every contiguous row sharing one key. */
interface HostnameGroup {
	key: string;
	brandIds: Set<string>;
	citationCount: number;
	/** Last (domain, brandId) row of the group — the cursor once it settles. */
	endPosition: BackfillCursor;
}

function emptyInventory(): BackfillInventory {
	return {
		scannedCitations: 0,
		distinctHostnames: 0,
		invalid: 0,
		brandOrCompetitorSkipped: 0,
		deterministicSkipped: 0,
		cachedCurrentSkipped: 0,
		staleCached: 0,
		eligible: 0,
		pagesScanned: 0,
		partial: false,
	};
}

const EMPTY_SET: Set<string> = new Set();

/** Decide one hostname group short of the cache check. */
function decideHostname(
	hostname: string,
	brandIds: Set<string>,
	brandContexts: Map<string, BackfillBrandContext>,
): "brandOrCompetitorSkipped" | "deterministicSkipped" | "candidate" {
	const contexts = [...brandIds].map((brandId) => brandContexts.get(brandId));
	const brandOrCompetitorEverywhere =
		contexts.length > 0 &&
		contexts.every((context) => {
			if (!context) return false;
			const category = categorizeDomain(hostname, context.brandDomains, context.competitorDomains);
			return category === "brand" || category === "competitor";
		});
	if (brandOrCompetitorEverywhere) return "brandOrCompetitorSkipped";
	if (categorizeDomain(hostname, EMPTY_SET, EMPTY_SET) !== "other") return "deterministicSkipped";
	return "candidate";
}

/**
 * Paged, bounded backfill scan with exact resume semantics.
 *
 * The scan is ordered by `backfillOrderingKey`, so all rows of one logical
 * normalized hostname are contiguous and aggregate into one carry-over group —
 * no global seen-set exists. Per-run state is one page of rows plus at most
 * batchSize + 1 pending groups (reported as `peakPendingGroups`), independent
 * of the total number of distinct citation domains.
 *
 * A group is SETTLED when it is counted into the inventory and, if eligible in
 * enqueue mode, its send has resolved (accepted or deduplicated). The returned
 * `nextCursor` is always the end position of the last settled group, so it can
 * never lie past an eligible hostname that was not sent: hitting the accepted
 * limit, a throwing send, or `maxPages` stops BEFORE the first unsettled group
 * and a resumed run re-reads it in full (same aggregation, same decision, and
 * counted exactly once across the sequence — a resume sequence sums to the
 * same inventory as one uninterrupted scan). A throwing send leaves its own
 * hostname unsettled too, so a rerun retries it instead of silently losing it.
 *
 * Dry-run (no `enqueue`) performs no write, no queue send, and no LLM call.
 * Enqueue mode is explicit opt-in with `limit` as a hard cap on ACCEPTED jobs
 * (deduplicated null sends do not consume it).
 */
class BackfillScan {
	private readonly inventory = emptyInventory();
	private readonly classifierVersion: string;
	private readonly batchSize: number;
	private buffer: HostnameGroup | null = null;
	/** End position of the last settled group — the exact resume point. */
	private settledCursor: BackfillCursor | null;
	private stopped = false;
	private settledCount = 0;
	private attempted = 0;
	private accepted = 0;
	private deduplicated = 0;
	private failed = 0;
	private peakPendingGroups = 0;

	constructor(private readonly args: BackfillRunArgs) {
		this.classifierVersion = args.classifierVersion ?? SOURCE_CLASSIFIER_VERSION;
		this.batchSize = Math.max(1, Math.min(args.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE, BACKFILL_MAX_BATCH_SIZE));
		this.settledCursor = args.cursor ?? null;
	}

	async run(): Promise<BackfillRunResult> {
		let scanCursor: BackfillCursor | null = this.args.cursor ?? null;
		let scanComplete = false;

		while (!this.stopped) {
			const page = await this.args.source.fetchCitationPage(scanCursor, this.batchSize);
			if (page.rows.length === 0) {
				// No rows after the cursor: the buffered group (if any) is complete.
				if (this.buffer) await this.settleGroups([this.takeBuffer()]);
				scanComplete = !this.stopped;
				break;
			}
			this.inventory.pagesScanned++;

			const completed = this.absorbPage(page.rows);
			await this.settleGroups(completed);
			if (this.stopped) break;

			scanCursor = page.nextCursor;
			if (scanCursor === null) {
				// Final page: the buffered group can no longer grow.
				if (this.buffer) await this.settleGroups([this.takeBuffer()]);
				scanComplete = !this.stopped;
				break;
			}
			if (
				this.args.maxPages !== undefined &&
				this.inventory.pagesScanned >= this.args.maxPages &&
				this.settledCount > 0
			) {
				// Page budget exhausted. The buffered group is NOT settled — the
				// resumed run re-reads its rows (they sort after the settled cursor),
				// aggregates them in full, and counts it exactly once. The budget is
				// soft while nothing has settled yet: a single hostname group larger
				// than the budget is read to its end so every run makes progress
				// (state stays bounded — it is still just one buffered group).
				this.stopped = true;
			}
		}

		const nextCursor = scanComplete ? null : this.settledCursor;
		this.inventory.partial = !scanComplete;
		return {
			inventory: this.inventory,
			nextCursor,
			attempted: this.attempted,
			accepted: this.accepted,
			deduplicated: this.deduplicated,
			failed: this.failed,
			peakPendingGroups: this.peakPendingGroups,
		};
	}

	/** Fold one page of rows into groups; returns the groups the page closed. */
	private absorbPage(rows: BackfillCitationPageRow[]): HostnameGroup[] {
		const completed: HostnameGroup[] = [];
		for (const row of rows) {
			if (this.buffer && this.buffer.key === row.key) {
				this.buffer.brandIds.add(row.brandId);
				this.buffer.citationCount += row.citationCount;
				this.buffer.endPosition = { key: row.key, domain: row.domain, brandId: row.brandId };
				continue;
			}
			if (this.buffer) completed.push(this.buffer);
			this.buffer = {
				key: row.key,
				brandIds: new Set([row.brandId]),
				citationCount: row.citationCount,
				endPosition: { key: row.key, domain: row.domain, brandId: row.brandId },
			};
		}
		this.peakPendingGroups = Math.max(this.peakPendingGroups, completed.length + (this.buffer ? 1 : 0));
		return completed;
	}

	private takeBuffer(): HostnameGroup {
		const group = this.buffer as HostnameGroup;
		this.buffer = null;
		return group;
	}

	/**
	 * Settle groups in scan order: one bounded cache lookup for the batch, then
	 * count each group and (in enqueue mode) send its hostname. Stops before the
	 * first group it cannot settle — accepted limit reached or a send failure —
	 * leaving `settledCursor` exactly at the last settled group.
	 */
	private async settleGroups(groups: HostnameGroup[]): Promise<void> {
		if (groups.length === 0 || this.stopped) return;

		const decisions = groups.map((group) => {
			const hostname = normalizeSourceHostname(group.key);
			return {
				group,
				hostname,
				decision: hostname === null ? null : decideHostname(hostname, group.brandIds, this.args.brandContexts),
			};
		});
		const candidateHostnames = decisions
			.filter((entry) => entry.decision === "candidate")
			.map((entry) => entry.hostname as string);
		const cachedVersions =
			candidateHostnames.length > 0
				? await this.args.source.fetchCachedVersions(candidateHostnames)
				: new Map<string, string>();

		for (const { group, hostname, decision } of decisions) {
			if (this.stopped) return;
			const settled = await this.settleOne(group, hostname, decision, cachedVersions);
			if (!settled) {
				this.stopped = true;
				return;
			}
			this.settledCursor = group.endPosition;
			this.settledCount++;
		}
	}

	/** Settle a single group; false when it must be left for a resumed run. */
	private async settleOne(
		group: HostnameGroup,
		hostname: string | null,
		decision: "brandOrCompetitorSkipped" | "deterministicSkipped" | "candidate" | null,
		cachedVersions: Map<string, string>,
	): Promise<boolean> {
		if (hostname === null || decision === null) {
			this.count(group, "invalid");
			return true;
		}
		if (decision !== "candidate") {
			this.count(group, decision);
			return true;
		}

		const cachedVersion = cachedVersions.get(hostname);
		if (cachedVersion === this.classifierVersion) {
			this.count(group, "cachedCurrentSkipped");
			return true;
		}

		const enqueue = this.args.enqueue;
		if (enqueue) {
			// The hard cap: an eligible hostname beyond the limit stays unsettled so
			// the cursor stops before it and a resumed run picks it up.
			if (this.accepted >= enqueue.limit) return false;
			this.attempted++;
			try {
				const jobId = await enqueue.send(hostname);
				if (jobId === null) this.deduplicated++;
				else this.accepted++;
			} catch (error) {
				// The failed hostname itself stays unsettled and is retried on resume.
				this.failed++;
				console.error(`Backfill: failed to enqueue "${hostname}" (resume to retry it):`, error);
				return false;
			}
		}

		if (cachedVersion !== undefined) this.inventory.staleCached++;
		this.count(group, "eligible");
		return true;
	}

	private count(
		group: HostnameGroup,
		bucket: "invalid" | "brandOrCompetitorSkipped" | "deterministicSkipped" | "cachedCurrentSkipped" | "eligible",
	): void {
		this.inventory.scannedCitations += group.citationCount;
		this.inventory.distinctHostnames++;
		this.inventory[bucket]++;
	}
}
