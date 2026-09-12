import type { ValidatedEntitySentiment } from "../classifier";
import type { GoldenCase } from "./corpus";

export interface GoldenCaseScore {
	id: string;
	critical: boolean;
	/** Every expected entity present with a valid result. */
	valid: boolean;
	categoryMatches: number;
	categoryTotal: number;
	scoreInRange: number;
	aspectMatches: number;
	aspectTotal: number;
	failures: string[];
}

export interface GoldenSummary {
	cases: number;
	validRate: number;
	categoryAgreement: number;
	scoreRangeAgreement: number;
	aspectAgreement: number;
	criticalPassRate: number;
	failures: string[];
}

/** Gates from the SENT-01 contract. */
export const GOLDEN_GATES = {
	validRate: 1,
	criticalPassRate: 1,
	categoryAgreement: 0.9,
	aspectAgreement: 0.85,
} as const;

/**
 * Score one case: a classifier output (already validated against the schema,
 * identities, consistency and evidence) is compared with the labelled
 * expectations. Scores are judged by range, never by an exact number.
 */
export function scoreGoldenCase(goldenCase: GoldenCase, entities: ValidatedEntitySentiment[] | null): GoldenCaseScore {
	const failures: string[] = [];
	const score: GoldenCaseScore = {
		id: goldenCase.id,
		critical: goldenCase.critical === true,
		valid: entities !== null,
		categoryMatches: 0,
		categoryTotal: 0,
		scoreInRange: 0,
		aspectMatches: 0,
		aspectTotal: 0,
		failures,
	};
	if (entities === null) {
		failures.push(`${goldenCase.id}: invalid classifier output`);
		return score;
	}
	const byKey = new Map(entities.map((entity) => [entity.key, entity]));
	for (const [key, expected] of Object.entries(goldenCase.expected)) {
		score.categoryTotal++;
		const actual = byKey.get(key);
		if (!actual) {
			failures.push(`${goldenCase.id}/${key}: missing`);
			continue;
		}
		if (actual.category === expected.category) score.categoryMatches++;
		else
			failures.push(`${goldenCase.id}/${key}: expected ${expected.category}, got ${actual.category} (${actual.score})`);
		if (actual.score >= expected.scoreRange[0] && actual.score <= expected.scoreRange[1]) score.scoreInRange++;
		else failures.push(`${goldenCase.id}/${key}: score ${actual.score} outside ${expected.scoreRange.join("–")}`);
		for (const [aspectKey, aspectExpected] of Object.entries(expected.aspects ?? {})) {
			score.aspectTotal++;
			const aspect = actual.aspects.find((candidate) => candidate.key === aspectKey);
			if (aspect && aspect.category === aspectExpected?.category) score.aspectMatches++;
			else
				failures.push(
					`${goldenCase.id}/${key}/${aspectKey}: expected ${aspectExpected?.category}, got ${aspect?.category ?? "none"}`,
				);
		}
	}
	return score;
}

export function summarizeGolden(scores: GoldenCaseScore[]): GoldenSummary {
	const sum = (pick: (s: GoldenCaseScore) => number) => scores.reduce((total, s) => total + pick(s), 0);
	const critical = scores.filter((s) => s.critical);
	const criticalPassed = critical.filter(
		(s) => s.valid && s.categoryMatches === s.categoryTotal && s.scoreInRange === s.categoryTotal,
	);
	const rate = (num: number, den: number) => (den === 0 ? 1 : num / den);
	return {
		cases: scores.length,
		validRate: rate(scores.filter((s) => s.valid).length, scores.length),
		categoryAgreement: rate(
			sum((s) => s.categoryMatches),
			sum((s) => s.categoryTotal),
		),
		scoreRangeAgreement: rate(
			sum((s) => s.scoreInRange),
			sum((s) => s.categoryTotal),
		),
		aspectAgreement: rate(
			sum((s) => s.aspectMatches),
			sum((s) => s.aspectTotal),
		),
		criticalPassRate: rate(criticalPassed.length, critical.length),
		failures: scores.flatMap((s) => s.failures),
	};
}

export function goldenGatesPass(summary: GoldenSummary): boolean {
	return (
		summary.validRate >= GOLDEN_GATES.validRate &&
		summary.criticalPassRate >= GOLDEN_GATES.criticalPassRate &&
		summary.categoryAgreement >= GOLDEN_GATES.categoryAgreement &&
		summary.aspectAgreement >= GOLDEN_GATES.aspectAgreement
	);
}
