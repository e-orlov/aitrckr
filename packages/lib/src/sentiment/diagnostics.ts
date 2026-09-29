import { z } from "zod";
import { EVIDENCE_MAX_ITEMS, SENTIMENT_ASPECT_KEYS } from "./types";

/** Where a post-response defect was detected. */
export const DIAGNOSTIC_STAGES = ["provider-schema", "entity", "aspect", "evidence", "cross-field"] as const;
export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];

/** Stable reasons; each is also the `code` of the corresponding validation error. */
export const DIAGNOSTIC_REASONS = [
	"invalid-json",
	"schema",
	"model-mismatch",
	"no-candidates",
	"answer-unsegmentable",
	/** The request schema for this answer and roster would break a documented provider limit; refused before any request (classifier v4). */
	"schema-budget-exceeded",
	"unknown-entity",
	"duplicate-entity",
	"missing-entity",
	"score-category",
	"duplicate-aspect",
	"evidence-unknown-anchor",
	"evidence-duplicate",
	"evidence-anchor-polarity-conflict",
	"mixed-needs-dual-evidence",
	"evidence-not-in-answer",
	/** A target's category does not fit the polarities of its citations (classifier v4). */
	"polarity-category-mismatch",
	/** A cited anchor explicitly names another candidate but not the claimed one (classifier v4). */
	"evidence-entity-unbound",
	/** No cited anchor of an entity's overall verdict is attributable to that entity (classifier v4). */
	"entity-ungrounded",
	/** No cited anchor of an aspect is attributable to the aspect's entity (classifier v4). */
	"aspect-ungrounded",
] as const;
export type DiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];

/** Whether a stored error code names a local validation defect (as opposed to a provider, store or contract failure). */
export function isValidationCode(code: unknown): code is DiagnosticReason {
	return typeof code === "string" && (DIAGNOSTIC_REASONS as readonly string[]).includes(code);
}

/** Upper bound of the serialized diagnostic; the field bounds below keep every instance under it. */
export const DIAGNOSTIC_MAX_BYTES = 512;

const ENTITY_KEY = /^[A-Za-z0-9-]{1,64}$/;
/** An anchor id, or — for a legacy free-text value — a truncated SHA-256 of it, never the value itself. */
const ANCHOR_OR_HASH = /^(?:s\d{4}|sha256:[0-9a-f]{16})$/;
const GENERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The only structured detail a locally rejected provider answer may leave
 * behind: enumerated stage and reason, bounded identifiers and counts. It is
 * stored on the analysis row, thrown with the job error, logged and reported
 * by the canary — so it can never carry the answer, the completion, an
 * excerpt, the prompt, a header or a credential.
 */
export const sentimentDiagnosticSchema = z.strictObject({
	stage: z.enum(DIAGNOSTIC_STAGES),
	entityKey: z.string().regex(ENTITY_KEY).nullable(),
	aspectKey: z.enum(SENTIMENT_ASPECT_KEYS).nullable(),
	evidenceIndex: z
		.number()
		.int()
		.min(0)
		.max(EVIDENCE_MAX_ITEMS - 1)
		.nullable(),
	anchorId: z.string().regex(ANCHOR_OR_HASH).nullable(),
	reason: z.enum(DIAGNOSTIC_REASONS),
	/** Legacy free-text evidence only: lengths, never content. */
	quoteLength: z.number().int().min(0).max(100_000).nullable(),
	rawLength: z.number().int().min(0).max(100_000).nullable(),
	normalizedLength: z.number().int().min(0).max(100_000).nullable(),
	generationId: z.string().regex(GENERATION_ID).nullable(),
});

export type SentimentDiagnostic = z.infer<typeof sentimentDiagnosticSchema>;

/** A diagnostic with every optional field nulled; callers set only what they know. */
export function diagnostic(
	stage: DiagnosticStage,
	reason: DiagnosticReason,
	detail: Partial<Omit<SentimentDiagnostic, "stage" | "reason">> = {},
): SentimentDiagnostic {
	return {
		stage,
		reason,
		entityKey: detail.entityKey ?? null,
		aspectKey: detail.aspectKey ?? null,
		evidenceIndex: detail.evidenceIndex ?? null,
		anchorId: detail.anchorId ?? null,
		quoteLength: detail.quoteLength ?? null,
		rawLength: detail.rawLength ?? null,
		normalizedLength: detail.normalizedLength ?? null,
		generationId: detail.generationId ?? null,
	};
}

/** Validate, then serialize; a diagnostic that does not fit the contract or the byte cap is dropped, never truncated into garbage. */
export function serializeDiagnostic(value: unknown): string | null {
	const parsed = sentimentDiagnosticSchema.safeParse(value);
	if (!parsed.success) return null;
	const json = JSON.stringify(parsed.data);
	return Buffer.byteLength(json, "utf8") <= DIAGNOSTIC_MAX_BYTES ? json : null;
}

/** A provider generation id is kept only when it looks like an opaque identifier. */
export function safeGenerationId(value: unknown): string | null {
	return typeof value === "string" && GENERATION_ID.test(value) ? value : null;
}
