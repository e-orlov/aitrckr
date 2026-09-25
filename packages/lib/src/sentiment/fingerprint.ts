import { createHash } from "node:crypto";
import { OPENROUTER_API_URL } from "../providers/registry/openrouter";
import { SENTIMENT_MODEL, SENTIMENT_PROVIDER_ID, SENTIMENT_SCHEMA_DEFINITIONS } from "./types";

export const SCHEMA_FINGERPRINT_VERSION = "sfp1";
export const REQUEST_PROFILE_VERSION = "rp1";

/** `$defs` entries whose values are run-specific (per-answer anchors, per-brand keys); everything else is contract. */
const TEMPLATE_DEFINITIONS: ReadonlySet<string> = new Set([
	SENTIMENT_SCHEMA_DEFINITIONS.anchorId,
	SENTIMENT_SCHEMA_DEFINITIONS.entityKey,
]);

/** JSON Schema keywords whose array order carries no meaning. */
const ORDER_INSENSITIVE_ARRAYS: ReadonlySet<string> = new Set(["required", "enum"]);

function canonical(value: unknown, key: string | null): unknown {
	if (Array.isArray(value)) {
		const items = value.map((v) => canonical(v, null));
		if (key !== null && ORDER_INSENSITIVE_ARRAYS.has(key) && items.every((v) => typeof v === "string")) {
			return [...(items as string[])].sort();
		}
		return items;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v, k)]));
	}
	return value;
}

/** Stable serialization: sorted object keys, order-insensitive `required`/`enum`, no whitespace. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value, null));
}

/**
 * The `sfp1:` shape of a serialized strict-output document: the exact wire
 * document with only the two run-specific `$defs` (anchor ids, entity keys)
 * replaced by a template marker, whatever form they took (enum or string
 * fallback). Verdicts, issue codes, aspect enums, constraints, closure,
 * references and nesting all remain part of the shape. A document without
 * both template definitions is fingerprinted literally.
 */
export function schemaShapeFingerprint(document: Record<string, unknown>): string {
	const defs = document.$defs;
	let shaped: Record<string, unknown> = document;
	if (defs !== null && typeof defs === "object" && !Array.isArray(defs)) {
		const names = Object.keys(defs as Record<string, unknown>);
		if ([...TEMPLATE_DEFINITIONS].every((name) => names.includes(name))) {
			const templated = Object.fromEntries(
				Object.entries(defs as Record<string, unknown>).map(([name, definition]) => [
					name,
					TEMPLATE_DEFINITIONS.has(name) ? { $template: name } : definition,
				]),
			);
			shaped = { ...document, $defs: templated };
		}
	}
	return `${SCHEMA_FINGERPRINT_VERSION}:${createHash("sha256").update(canonicalJson(shaped)).digest("hex")}`;
}

export interface RequestProfile {
	adapter: string;
	endpoint: string;
	model: string;
	tools: { kind: string; maxToolCalls: number; toolChoice: string } | null;
	output: { mode: "json_schema"; strict: true; requireParameters: true };
	/** `sfp1:` fingerprint of the schema the request carries. */
	schema: string;
	/** The capacity tier is part of the breaker and permit scope when explicitly pinned. */
	serviceTier?: "flex";
}

/**
 * The effective sentiment request shape as the OpenRouter adapter sends it:
 * the locked provider and model, the web-search tool block (classify) or none
 * (repair, verify), strict JSON-schema output with strict parameter routing,
 * and the schema shape. Never the prompt, the document or a credential.
 */
export function sentimentRequestProfile(args: {
	webSearch: boolean;
	schemaFp: string;
	serviceTier?: "flex";
}): RequestProfile {
	return {
		adapter: SENTIMENT_PROVIDER_ID,
		endpoint: OPENROUTER_API_URL,
		model: SENTIMENT_MODEL,
		tools: args.webSearch ? { kind: "openrouter:web_search", maxToolCalls: 1, toolChoice: "required" } : null,
		output: { mode: "json_schema", strict: true, requireParameters: true },
		schema: args.schemaFp,
		...(args.serviceTier === "flex" ? { serviceTier: "flex" as const } : {}),
	};
}

/** The `rp1:` breaker scope key of a request profile. */
export function requestScopeKey(profile: RequestProfile): string {
	return `${REQUEST_PROFILE_VERSION}:${createHash("sha256").update(canonicalJson(profile)).digest("hex")}`;
}
