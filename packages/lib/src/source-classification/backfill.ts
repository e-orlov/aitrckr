import { categorizeDomain } from "../citations/domain-categories.server";
import { normalizeSourceHostname } from "./hostname";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

export interface BackfillBrandContext {
	brandDomains: Set<string>;
	competitorDomains: Set<string>;
}

/** Keyset cursor over the grouped (domain, brand_id) citation scan. */
export interface BackfillCursor {
	domain: string;
	brandId: string;
}

export interface BackfillCitationPageRow {
	domain: string;
	brandId: string;
	/** Citations behind this (domain, brand) pair. */
	citationCount: number;
}

export interface BackfillCitationPage {
	/** Rows ordered by (domain, brandId) ascending. */
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

export interface BackfillInventory {
	scannedCitations: number;
	distinctHostnames: number;
	invalid: number;
	brandOrCompetitorSkipped: number;
	deterministicSkipped: number;
	cachedCurrentSkipped: number;
	staleCached: number;
	eligible: number;
	pagesScanned: number;
	/** True when the scan stopped before exhausting the table (maxPages or accept limit). */
	partial: boolean;
}

export interface BackfillRunResult {
	inventory: BackfillInventory;
	/** Resume point when `inventory.partial`; null when the scan completed. */
	nextCursor: BackfillCursor | null;
	/** Eligible hostnames a send was attempted for (0 in dry-run). */
	attempted: number;
	/** Sends pg-boss accepted (non-null job id). */
	accepted: number;
	/** Sends deduplicated by the exclusive queue policy (null job id). */
	deduplicated: number;
	/** Sends that threw. */
	failed: number;
}

/** Hard ceiling on a citation page so no run can ask for an unbounded scan. */
export const BACKFILL_MAX_BATCH_SIZE = 20_000;
export const BACKFILL_DEFAULT_BATCH_SIZE = 5_000;

interface DomainAggregate {
	domain: string;
	brandIds: Set<string>;
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

/**
 * Decide one hostname (all citing brands aggregated). Returns which inventory
 * bucket it lands in short of the cache check.
 */
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
 * Paged, bounded backfill scan. Reads the citation inventory in keyset pages of
 * at most `batchSize` grouped (domain, brand) rows and checks the cache one
 * bounded hostname batch per page — the full citation inventory, the full
 * cache, and a full eligible-hostname list are never materialized at once (the
 * only cross-page state is the set of already-decided normalized hostnames,
 * bounded by distinct hostnames, which preserves normalization/dedup across
 * page boundaries).
 *
 * Dry-run (no `enqueue` argument) performs no write, no queue send, and no LLM
 * call — it only counts, either over the whole table or, with `maxPages`, over
 * a bounded prefix reported as `partial` with a resumable `nextCursor`.
 *
 * Enqueue mode is explicit opt-in: `enqueue.limit` is a hard upper bound on
 * ACCEPTED jobs (null send results count as deduplicated, not accepted; a
 * throwing send counts as failed and never resets earlier successes). Repeat
 * runs are idempotent and make progress: previously accepted hostnames are
 * filtered by the cache or deduplicated by the exclusive queue policy, so a
 * rerun spends its limit on new hostnames instead of the first page.
 *
 * A raw domain whose grouped rows straddle a page boundary is held in a
 * carry-over buffer and decided only when the next domain (or the end of the
 * scan) is seen, so page boundaries neither drop nor double-process it.
 */
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

/** One scan's state: counts, cross-page dedupe, and the carry-over buffer. */
class BackfillScan {
	private readonly inventory = emptyInventory();
	private readonly decided = new Set<string>();
	private readonly invalidDomains = new Set<string>();
	private readonly classifierVersion: string;
	private readonly batchSize: number;
	private buffer: DomainAggregate | null = null;
	private cursor: BackfillCursor | null;
	private stop = false;
	private attempted = 0;
	private accepted = 0;
	private deduplicated = 0;
	private failed = 0;

	constructor(private readonly args: BackfillRunArgs) {
		this.classifierVersion = args.classifierVersion ?? SOURCE_CLASSIFIER_VERSION;
		this.batchSize = Math.max(1, Math.min(args.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE, BACKFILL_MAX_BATCH_SIZE));
		this.cursor = args.cursor ?? null;
	}

	async run(): Promise<BackfillRunResult> {
		while (!this.stop) {
			const page = await this.args.source.fetchCitationPage(this.cursor, this.batchSize);
			if (page.rows.length === 0) {
				this.cursor = null; // the previous page was the last full one; the scan is complete
				break;
			}
			await this.processPage(page);
			if (this.cursor === null) break;
			if (this.args.maxPages !== undefined && this.inventory.pagesScanned >= this.args.maxPages) this.stop = true;
		}

		// Decide the still-buffered (possibly page-straddling) domain from what was
		// seen. On a bounded stop the resumed run re-reads its remaining rows and
		// may re-decide it — the cache filter and the exclusive queue policy keep
		// that safe (no duplicate paid work), at the cost of one possibly
		// double-counted hostname across resumed bounded runs.
		if (this.buffer) {
			const candidates: string[] = [];
			this.finalizeDomain(this.buffer, candidates);
			this.buffer = null;
			await this.settleCandidates(candidates);
		}

		this.inventory.partial = this.cursor !== null;
		return {
			inventory: this.inventory,
			nextCursor: this.cursor,
			attempted: this.attempted,
			accepted: this.accepted,
			deduplicated: this.deduplicated,
			failed: this.failed,
		};
	}

	private async processPage(page: BackfillCitationPage): Promise<void> {
		this.inventory.pagesScanned++;
		const candidates: string[] = [];
		for (const row of page.rows) {
			this.inventory.scannedCitations += row.citationCount;
			if (this.buffer && this.buffer.domain === row.domain) {
				this.buffer.brandIds.add(row.brandId);
				continue;
			}
			if (this.buffer) this.finalizeDomain(this.buffer, candidates);
			this.buffer = { domain: row.domain, brandIds: new Set([row.brandId]) };
		}
		// The buffered (possibly page-straddling) domain is finalized either by the
		// next page's first differing row or by run() after the last page.
		if (page.nextCursor === null && this.buffer) {
			this.finalizeDomain(this.buffer, candidates);
			this.buffer = null;
		}
		await this.settleCandidates(candidates);
		this.cursor = page.nextCursor;
	}

	/** Aggregate one finalized raw domain into a per-page candidate list. */
	private finalizeDomain(aggregate: DomainAggregate, candidates: string[]): void {
		const hostname = normalizeSourceHostname(aggregate.domain);
		if (!hostname) {
			if (!this.invalidDomains.has(aggregate.domain)) {
				this.invalidDomains.add(aggregate.domain);
				this.inventory.invalid++;
				this.inventory.distinctHostnames++;
			}
			return;
		}
		if (this.decided.has(hostname)) return;
		this.decided.add(hostname);
		this.inventory.distinctHostnames++;
		const decision = decideHostname(hostname, aggregate.brandIds, this.args.brandContexts);
		if (decision === "candidate") candidates.push(hostname);
		else this.inventory[decision]++;
	}

	/** Cache-check one bounded candidate batch, then count/enqueue the eligible. */
	private async settleCandidates(candidates: string[]): Promise<void> {
		if (candidates.length === 0) return;
		const cachedVersions = await this.args.source.fetchCachedVersions(candidates);
		for (const hostname of candidates) {
			const cachedVersion = cachedVersions.get(hostname);
			if (cachedVersion === this.classifierVersion) {
				this.inventory.cachedCurrentSkipped++;
				continue;
			}
			if (cachedVersion !== undefined) this.inventory.staleCached++;
			this.inventory.eligible++;
			await this.maybeEnqueue(hostname);
		}
	}

	/** Send one eligible hostname while the accepted-jobs hard cap allows it. */
	private async maybeEnqueue(hostname: string): Promise<void> {
		const enqueue = this.args.enqueue;
		if (!enqueue || this.accepted >= enqueue.limit) return;
		this.attempted++;
		try {
			const jobId = await enqueue.send(hostname);
			if (jobId === null) this.deduplicated++;
			else this.accepted++;
		} catch (error) {
			this.failed++;
			console.error(`Backfill: failed to enqueue "${hostname}" (continuing):`, error);
		}
		if (this.accepted >= enqueue.limit) this.stop = true;
	}
}
