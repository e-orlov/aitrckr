import { and, eq, inArray } from "drizzle-orm";
import type { SupplementalDomainCategory } from "../citations/domain-categories.server";
import { db } from "../db/db";
import { type SourceDomainClassificationRecord, sourceDomainClassifications } from "../db/schema";
import {
	SOURCE_CLASSIFICATION_CATEGORIES,
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassification,
	sourceClassificationResultSchema,
} from "./types";

// Bound on hostnames per SELECT so a read never builds an unbounded IN list.
const LOOKUP_CHUNK_SIZE = 1000;

function chunk<T>(values: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
	return out;
}

/**
 * Current-version cache rows for the given normalized hostnames, one bounded
 * query per chunk. Rows with a different classifier version are stale and are
 * not returned — callers treat them exactly like a missing row.
 */
export async function getCurrentSourceClassifications(
	hostnames: string[],
	classifierVersion: string = SOURCE_CLASSIFIER_VERSION,
): Promise<Map<string, SourceDomainClassificationRecord>> {
	const result = new Map<string, SourceDomainClassificationRecord>();
	const unique = [...new Set(hostnames)];
	if (unique.length === 0) return result;

	for (const part of chunk(unique, LOOKUP_CHUNK_SIZE)) {
		const rows = await db
			.select()
			.from(sourceDomainClassifications)
			.where(
				and(
					inArray(sourceDomainClassifications.hostname, part),
					eq(sourceDomainClassifications.classifierVersion, classifierVersion),
				),
			);
		for (const row of rows) result.set(row.hostname, row);
	}
	return result;
}

const SUPPLEMENTAL_CATEGORY_SET: ReadonlySet<string> = new Set(SOURCE_CLASSIFICATION_CATEGORIES);

/**
 * Read-path lookup: every current-version cache row, as one of the nine
 * classifiable categories. A cached `other` is a full result — it is returned
 * so the read path treats the hostname as classified (no page fallback) and no
 * repeat LLM call is warranted. Rows with an out-of-contract category (only
 * possible through outside interference) are dropped rather than surfaced.
 */
export async function getSupplementalDomainCategories(
	hostnames: string[],
): Promise<Map<string, SupplementalDomainCategory>> {
	const rows = await getCurrentSourceClassifications(hostnames);
	const result = new Map<string, SupplementalDomainCategory>();
	for (const [hostname, row] of rows) {
		if (SUPPLEMENTAL_CATEGORY_SET.has(row.category)) {
			result.set(hostname, row.category as SupplementalDomainCategory);
		}
	}
	return result;
}

/** Hostnames from the input that have no current-version row (dedupe filter). */
export async function filterHostnamesNeedingClassification(hostnames: string[]): Promise<string[]> {
	const unique = [...new Set(hostnames)];
	if (unique.length === 0) return [];
	const current = await getCurrentSourceClassifications(unique);
	return unique.filter((hostname) => !current.has(hostname));
}

/**
 * Persist one validated classification atomically. INSERT … ON CONFLICT on the
 * hostname primary key, so concurrent duplicate jobs and stale-row replacement
 * both resolve deterministically to a single current row. Validates the value
 * once more at the persistence boundary — an invalid result must never become
 * a cache row, whatever path produced it.
 */
export async function upsertSourceClassification(classification: SourceClassification): Promise<void> {
	const validated = sourceClassificationResultSchema.parse({
		category: classification.category,
		confidence: classification.confidence,
		reason: classification.reason,
	});

	const now = new Date();
	const values = {
		hostname: classification.hostname,
		category: validated.category,
		confidence: validated.confidence.toFixed(3),
		reason: validated.reason,
		provider: classification.provider,
		model: classification.model,
		classifierVersion: classification.classifierVersion,
		classifiedAt: now,
	};

	await db
		.insert(sourceDomainClassifications)
		.values(values)
		.onConflictDoUpdate({
			target: sourceDomainClassifications.hostname,
			set: {
				category: values.category,
				confidence: values.confidence,
				reason: values.reason,
				provider: values.provider,
				model: values.model,
				classifierVersion: values.classifierVersion,
				classifiedAt: values.classifiedAt,
				updatedAt: now,
			},
		});
}
