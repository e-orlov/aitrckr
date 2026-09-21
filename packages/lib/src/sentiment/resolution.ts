import { z } from "zod";
import { type EvidenceAnchor, segmentAnswer } from "./anchors";

export { assessCandidate, type CandidateAssessment, type UnresolvedTarget } from "./classifier";

import type { UnresolvedTarget } from "./classifier";
import {
	aspectTaxonomyText,
	renderAnchoredAnswer,
	SENTIMENT_ASPECT_ROUTING_RULES,
	SENTIMENT_EVIDENCE_RULES,
	SENTIMENT_GROUNDING_RULES,
	SENTIMENT_KEY_RULES,
	SENTIMENT_SCORE_RULES,
} from "./prompt";
import type { AnalyzableText } from "./ranges";
import {
	ANCHOR_ID_PATTERN,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_SCHEMA_DEFINITIONS,
	type SentimentAspectKey,
	type SentimentCandidate,
	type SentimentClassificationResult,
	type SentimentEntityResult,
	sentimentClassificationResultSchema,
	sentimentProviderResultSchemaFor,
	sortSentimentEntities,
} from "./types";

/**
 * Independent semantic verification contract. Bumped when the verifier prompt
 * or its issue vocabulary changes; stored on every analysis it accepted.
 */
export const SENTIMENT_VERIFIER_VERSION = "sent-verifier-v1";

/** Verification by an operator through the adjudication CLI, recorded in place of the verifier version. */
export const HUMAN_ADJUDICATION_VERSION = "human-adjudication-v1";

export const RESOLUTION_CASE_STATUSES = [
	"open",
	"repairing",
	"verifying",
	"retry_wait",
	"awaiting_review",
	"awaiting_reconciliation",
	"resolved",
] as const;
export type ResolutionCaseStatus = (typeof RESOLUTION_CASE_STATUSES)[number];

export const REVIEW_REASONS = [
	"call-limit",
	"cost-limit",
	"contract-defect",
	"unknown-provider-outcome",
	"initial-classification-limit",
	"retry-exhausted",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export interface ResolutionPolicy {
	/** Paid provider answers one analysis may consume automatically, all phases together. */
	maxPaidCalls: number;
	/** Charged cost one analysis may consume automatically, in USD. */
	maxCostUsd: number;
	/** Initial (web-search) classifications per analysis; every further call is a repair or a verification. */
	maxInitialClassifications: number;
	/** Bounded backoff after a transient provider error. */
	backoffBaseMs: number;
	backoffMaxMs: number;
	/** Consecutive unpaid transient refusals before the case is handed to review as `retry-exhausted` (D20). */
	maxConsecutiveTransientFailures: number;
}

/**
 * The automatic resolution budget of one analysis. Reaching any bound hands
 * the run to `awaiting_review`; it never closes it as a failure. Unpaid
 * attempts (transport errors, refusals before a request left) do not count.
 */
export const RESOLUTION_POLICY: Readonly<ResolutionPolicy> = Object.freeze({
	maxPaidCalls: 5,
	maxCostUsd: 0.15,
	maxInitialClassifications: 1,
	backoffBaseMs: 60_000,
	backoffMaxMs: 15 * 60_000,
	maxConsecutiveTransientFailures: 5,
});

/** Delay before the next automatic attempt after the n-th consecutive transient failure. */
export function backoffMs(consecutiveFailures: number, policy: ResolutionPolicy = RESOLUTION_POLICY): number {
	const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
	return Math.min(policy.backoffBaseMs * 2 ** exponent, policy.backoffMaxMs);
}

/** The repair request accepts exactly the unresolved keys and this answer's anchors. */
export function repairResultSchemaFor(anchorIds: readonly string[], targetKeys: readonly string[]) {
	return sentimentProviderResultSchemaFor(anchorIds, targetKeys);
}

const entityListText = (candidates: SentimentCandidate[], only?: Set<string>) =>
	sortSentimentEntities(candidates)
		.filter((c) => !only || only.has(c.key))
		.map((c) => {
			const aliases = c.aliases.length > 0 ? ` (also known as: ${c.aliases.join(", ")})` : "";
			const role = c.entityType === "brand" ? "the brand being tracked" : "a competitor";
			return `- key "${c.key}": ${c.name}${aliases} — ${role}`;
		})
		.join("\n");

/**
 * Phase C prompt: the same rules as the classification, restricted to the
 * unresolved entities, with the safe diagnostics of the rejected claims. No
 * web search: everything the model needs is the stored answer.
 */
export function buildRepairPrompt(args: {
	answerBody: string;
	candidates: SentimentCandidate[];
	anchors?: readonly EvidenceAnchor[];
	targets: UnresolvedTarget[];
}): string {
	const anchors = args.anchors ?? segmentAnswer(args.answerBody);
	const targetKeys = new Set(args.targets.map((t) => t.entityKey));
	const diagnostics = args.targets
		.map(
			(t) =>
				`- key "${t.entityKey}"${t.aspectKey ? ` aspect "${t.aspectKey}"` : " overall"}: ${t.reason}${t.anchorId ? ` (cited segment ${t.anchorId})` : ""}`,
		)
		.join("\n");
	return `You are repairing part of an earlier structured judgement of how an AI assistant's stored answer portrays specific insurance companies. A previous attempt returned results for the REPAIR TARGETS below that the deterministic checks could not accept; the reasons are listed. Return one complete, corrected item for every repair target key — exactly those keys, no other key — judged only from the text of the ANSWER. Do not use any external information.

REPAIR TARGETS and why the previous result was refused:
${diagnostics}

${SENTIMENT_KEY_RULES}

${SENTIMENT_GROUNDING_RULES}

${SENTIMENT_SCORE_RULES}

Aspects: additionally rate the entity only on the aspects the ANSWER explicitly evaluates for it, using the canonical keys below; the aspect list may be empty.
${aspectTaxonomyText()}

${SENTIMENT_ASPECT_ROUTING_RULES}

${SENTIMENT_EVIDENCE_RULES}

ENTITIES (all candidates of this answer, for disambiguation; return items only for the repair targets):
${entityListText(args.candidates)}

REPAIR TARGETS (return exactly these keys):
${entityListText(args.candidates, targetKeys)}

ANSWER (segments; cite by id):
"""
${renderAnchoredAnswer(anchors)}
"""`;
}

/** The bounded vocabulary a verifier may object with; anything else is not representable. */
export const VERIFIER_ISSUE_CODES = [
	"entity-misattribution",
	"polarity-mismatch",
	"category-mismatch",
	"mixed-semantics",
	"aspect-misrouted",
	"unsupported-evaluation",
] as const;
export type VerifierIssueCode = (typeof VERIFIER_ISSUE_CODES)[number];

export interface VerifierIssue {
	entityKey: string;
	target: "overall" | SentimentAspectKey;
	code: VerifierIssueCode;
	anchorId: string | null;
}

export type VerifierResult = { verdict: "accept"; issues: [] } | { verdict: "reject"; issues: VerifierIssue[] };

export const VERIFIER_MAX_ISSUES = 12;

/**
 * Phase D wire contract: one strict object — a verdict and a bounded list of
 * structural issues naming an exact entity key, a target and a code from the
 * fixed vocabulary, optionally one of the answer's anchors. The root is a
 * plain object because strict structured outputs refuse a root union; the
 * relation between the verdict and the issue count (accept ⇔ no issue,
 * reject ⇔ at least one) cannot be expressed in that subset and is enforced
 * after wire parsing, so a contradictory answer is still rejected.
 */
export function verifierResultSchemaFor(anchorIds: readonly string[], entityKeys: readonly string[]) {
	// The same named leaf parts as the classify and repair requests: the per-answer anchor enum and the
	// entity-key enum are each emitted once under `$defs` and referenced from every site.
	const anchorId = (
		anchorIds.length > 0 ? z.enum(anchorIds as [string, ...string[]]) : z.string().regex(ANCHOR_ID_PATTERN)
	).meta({ id: SENTIMENT_SCHEMA_DEFINITIONS.anchorId });
	const entityKey = (entityKeys.length > 0 ? z.enum(entityKeys as [string, ...string[]]) : z.string().min(1)).meta({
		id: SENTIMENT_SCHEMA_DEFINITIONS.entityKey,
	});
	const issue = z.strictObject({
		entityKey,
		target: z.enum(["overall", ...SENTIMENT_ASPECT_KEYS]),
		code: z.enum(VERIFIER_ISSUE_CODES),
		anchorId: anchorId.nullable(),
	});
	return z
		.strictObject({
			verdict: z.enum(["accept", "reject"]),
			issues: z.array(issue).max(VERIFIER_MAX_ISSUES),
		})
		.superRefine((value, ctx) => {
			if (value.verdict === "accept" && value.issues.length > 0) {
				ctx.addIssue({ code: "custom", path: ["issues"], message: "an accepted verdict carries no issue" });
			}
			if (value.verdict === "reject" && value.issues.length === 0) {
				ctx.addIssue({ code: "custom", path: ["issues"], message: "a rejected verdict names at least one issue" });
			}
		});
}

/** Every verifier issue routes its entity to repair; an aspect issue is a repair of the entity, never a placeholder. */
export function verifierIssuesToTargets(issues: readonly VerifierIssue[]): UnresolvedTarget[] {
	return issues.map((issue) => ({
		entityKey: issue.entityKey,
		reason: `verifier:${issue.code}`,
		aspectKey: issue.target === "overall" ? null : issue.target,
		anchorId: issue.anchorId,
		source: "verifier",
	}));
}

/** A candidate as the verifier sees it: keys, verdicts and cited segment ids only. */
function renderCandidate(candidate: SentimentClassificationResult): string {
	return candidate.entities
		.map((entity) => {
			const cites = (refs: { anchorId: string; polarity: string }[]) =>
				refs.map((r) => `${r.anchorId}:${r.polarity}`).join(", ");
			const aspects = entity.aspects
				.map((a) => `    - aspect "${a.key}": ${a.category} ${a.score} — cites ${cites(a.evidence)}`)
				.join("\n");
			return `- key "${entity.key}": overall ${entity.category} ${entity.score} — cites ${cites(entity.evidence)}${aspects ? `\n${aspects}` : ""}`;
		})
		.join("\n");
}

/**
 * Phase D prompt: an independent check of a deterministically valid
 * candidate against the answer — attribution, polarity, category, Mixed
 * semantics, aspect routing, evaluative vs descriptive statements. It never
 * re-classifies, never adds information and cannot persist anything.
 */
export function buildVerifierPrompt(args: {
	answerBody: string;
	candidates: SentimentCandidate[];
	anchors?: readonly EvidenceAnchor[];
	candidate: SentimentClassificationResult;
}): string {
	const anchors = args.anchors ?? segmentAnswer(args.answerBody);
	return `You are an independent verifier of a structured judgement about how an AI assistant's stored answer portrays specific insurance companies. You do not classify again. You check the CANDIDATE below against the ANSWER only and return "accept", or "reject" with one bounded issue per defect. Do not use any external information; judge only what the ANSWER's segments say.

Check, for every entity and every aspect item of the CANDIDATE:
- entity attribution: every cited segment is about that entity (names it or unmistakably continues a sentence, list or table row that names it); a segment about another candidate, a generic checklist, a general tip or a heading is not evidence → "entity-misattribution";
- polarity: each cited segment carries the polarity claimed for that target → "polarity-mismatch";
- category: the verdict category follows from the cited polarities (only positive → positive; only negative → negative; descriptive only → neutral) → "category-mismatch";
- Mixed: a "mixed" verdict rests on at least one genuinely positive and one genuinely negative statement about the same target; a caveat inside one sentence may serve both sides → "mixed-semantics";
- aspect routing: a statement is filed under its canonical key (deductible and premiums → price; scope, limits, waiting periods → coverage; claims handling, advice, reachability → service; "other" only for explicit evaluations fitting no key) → "aspect-misrouted";
- evaluative vs descriptive: a bare name, ranking position, case count, usage share, growth figure or other statistic is not a positive or negative evaluation → "unsupported-evaluation".
Return "accept" only when no item has a defect. Name the exact entity key, the target ("overall" or the aspect key) and, when one segment is at fault, its id.

${SENTIMENT_KEY_RULES}

ENTITIES:
${entityListText(args.candidates)}

CANDIDATE:
${renderCandidate(args.candidate)}

ANSWER (segments):
"""
${renderAnchoredAnswer(anchors)}
"""`;
}

/**
 * Merge a repair into the candidate: only the targeted entities are replaced,
 * every accepted entity stays byte-identical; a repaired key outside the
 * targets is a contract defect of the repair answer.
 */
export function mergeRepairedEntities(
	candidate: SentimentClassificationResult,
	repaired: SentimentClassificationResult,
	targetKeys: readonly string[],
): SentimentClassificationResult {
	const targets = new Set(targetKeys);
	const byKey = new Map<string, SentimentEntityResult>();
	for (const entity of repaired.entities) {
		if (!targets.has(entity.key)) throw new Error(`repaired entity "${entity.key}" is not a repair target`);
		byKey.set(entity.key, entity);
	}
	const present = new Set(candidate.entities.map((entity) => entity.key));
	const inPlace = candidate.entities.map((entity) =>
		targets.has(entity.key) ? (byKey.get(entity.key) ?? entity) : entity,
	);
	const added = [...targets]
		.filter((key) => !present.has(key) && byKey.has(key))
		.map((key) => byKey.get(key) as SentimentEntityResult);
	return { entities: [...inPlace, ...added] };
}
