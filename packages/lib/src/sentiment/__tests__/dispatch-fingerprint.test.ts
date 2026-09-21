import { describe, expect, it } from "vitest";
import { prepareStructuredOutputSchema } from "../../providers/schema-contract";
import { sourceClassificationResultSchema } from "../../source-classification/types";
import { segmentAnswer } from "../anchors";
import {
	REQUEST_PROFILE_VERSION,
	requestScopeKey,
	SCHEMA_FINGERPRINT_VERSION,
	schemaShapeFingerprint,
	sentimentRequestProfile,
} from "../fingerprint";
import { repairResultSchemaFor, VERIFIER_MAX_ISSUES, verifierResultSchemaFor } from "../resolution";
import { sentimentProviderResultSchemaFor } from "../types";

const anchorsA = segmentAnswer("Alpha is fast. Beta is slow. Gamma is cheap.").map((a) => a.id);
const anchorsB = segmentAnswer("One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve.").map(
	(a) => a.id,
);
const keysA = ["brand", "5e970007-0000-4000-8000-00000000000a"];
const keysB = ["brand", "5e970007-0000-4000-8000-00000000000b", "5e970007-0000-4000-8000-00000000000c"];
const wire = (schema: Parameters<typeof prepareStructuredOutputSchema>[0]) => prepareStructuredOutputSchema(schema);
const fp = (schema: Parameters<typeof prepareStructuredOutputSchema>[0]) => schemaShapeFingerprint(wire(schema));

describe("sfp1 schema-shape fingerprint", () => {
	it("is versioned and hex", () => {
		expect(fp(verifierResultSchemaFor(anchorsA, keysA))).toMatch(
			new RegExp(`^${SCHEMA_FINGERPRINT_VERSION}:[0-9a-f]{64}$`),
		);
	});

	it("collides across runs: different anchors and entity keys give one verifier shape", () => {
		expect(fp(verifierResultSchemaFor(anchorsA, keysA))).toBe(fp(verifierResultSchemaFor(anchorsB, keysB)));
	});

	it("collides between the empty-list fallback form and the populated enum form", () => {
		expect(fp(verifierResultSchemaFor([], []))).toBe(fp(verifierResultSchemaFor(anchorsA, keysA)));
		expect(fp(sentimentProviderResultSchemaFor([], []))).toBe(fp(sentimentProviderResultSchemaFor(anchorsA, keysA)));
	});

	it("collides between classify and repair by construction (same document)", () => {
		expect(fp(sentimentProviderResultSchemaFor(anchorsA, keysA))).toBe(fp(repairResultSchemaFor(anchorsB, keysB)));
	});

	it("is insensitive to object key order and to the order of required/enum lists", () => {
		const doc = wire(verifierResultSchemaFor(anchorsA, keysA)) as {
			properties: Record<string, unknown>;
			required: string[];
			$defs: Record<string, unknown>;
		};
		const shuffled = {
			...doc,
			required: [...doc.required].reverse(),
			properties: Object.fromEntries(Object.entries(doc.properties).reverse()),
			$defs: Object.fromEntries(Object.entries(doc.$defs).reverse()),
		};
		expect(schemaShapeFingerprint(shuffled)).toBe(schemaShapeFingerprint(doc));
	});

	it("does not collide between verify and classify, or across material contract changes", () => {
		const verify = wire(verifierResultSchemaFor(anchorsA, keysA)) as Record<string, unknown>;
		const classify = wire(sentimentProviderResultSchemaFor(anchorsA, keysA));
		expect(schemaShapeFingerprint(verify)).not.toBe(schemaShapeFingerprint(classify));
		const properties = verify.properties as Record<string, Record<string, unknown>>;
		const issuesMax = {
			...verify,
			properties: { ...properties, issues: { ...properties.issues, maxItems: VERIFIER_MAX_ISSUES + 1 } },
		};
		expect(schemaShapeFingerprint(issuesMax)).not.toBe(schemaShapeFingerprint(verify));
		const verdict = properties.verdict as { enum: string[] };
		const widerVerdict = {
			...verify,
			properties: { ...properties, verdict: { ...verdict, enum: [...verdict.enum, "unsure"] } },
		};
		expect(schemaShapeFingerprint(widerVerdict)).not.toBe(schemaShapeFingerprint(verify));
		const { additionalProperties: _drop, ...openRoot } = verify;
		expect(schemaShapeFingerprint(openRoot)).not.toBe(schemaShapeFingerprint(verify));
		const rootUnion = { anyOf: [verify] };
		expect(schemaShapeFingerprint(rootUnion)).not.toBe(schemaShapeFingerprint(verify));
		const defs = verify.$defs as Record<string, unknown>;
		const renamed = {
			...verify,
			$defs: { ...Object.fromEntries(Object.entries(defs).filter(([k]) => k !== "anchorId")), anchor: defs.anchorId },
		};
		expect(schemaShapeFingerprint(renamed)).not.toBe(schemaShapeFingerprint(verify));
	});

	it("fingerprints a non-sentiment schema literally: its enum values are part of the shape", () => {
		const doc = wire(sourceClassificationResultSchema) as { properties: Record<string, Record<string, unknown>> };
		const category = doc.properties.category as { enum?: string[] } | undefined;
		if (!category?.enum) return;
		const widened = {
			...doc,
			properties: { ...doc.properties, category: { ...category, enum: [...category.enum, "zzz"] } },
		};
		expect(schemaShapeFingerprint(widened)).not.toBe(schemaShapeFingerprint(doc));
	});
});

describe("rp1 request-profile scope key", () => {
	const schemaFp = fp(sentimentProviderResultSchemaFor(anchorsA, keysA));

	it("is versioned, deterministic and separates classify (web search) from repair (no web search)", () => {
		const classify = sentimentRequestProfile({ webSearch: true, schemaFp });
		const repair = sentimentRequestProfile({ webSearch: false, schemaFp });
		expect(requestScopeKey(classify)).toMatch(new RegExp(`^${REQUEST_PROFILE_VERSION}:[0-9a-f]{64}$`));
		expect(requestScopeKey(classify)).toBe(requestScopeKey(sentimentRequestProfile({ webSearch: true, schemaFp })));
		expect(requestScopeKey(classify)).not.toBe(requestScopeKey(repair));
	});

	it("changes with the schema shape and carries no document, prompt or credential", () => {
		const other = sentimentRequestProfile({ webSearch: false, schemaFp: fp(verifierResultSchemaFor(anchorsA, keysA)) });
		expect(requestScopeKey(other)).not.toBe(requestScopeKey(sentimentRequestProfile({ webSearch: false, schemaFp })));
		const json = JSON.stringify(other);
		expect(json).not.toContain("$defs");
		expect(json).not.toContain("Bearer");
		expect(other.model).toBe("openai/gpt-5-mini");
		expect(other.adapter).toBe("openrouter");
		expect(other.output).toEqual({ mode: "json_schema", strict: true, requireParameters: true });
		expect(other.tools).toBeNull();
	});
});
