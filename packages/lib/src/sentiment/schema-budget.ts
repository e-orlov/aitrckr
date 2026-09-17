import { ANCHOR_ID_PATTERN, STRICT_STRUCTURED_OUTPUT_KEYWORDS } from "./types";

/**
 * Deterministic measurement of the JSON Schema exactly as it is sent to the
 * provider, against the documented strict structured-output limits
 * (https://developers.openai.com/api/docs/guides/structured-outputs, "Supported
 * schemas"). Two enum budgets are reported: the literal values present in the
 * serialized document (`raw`) and the values a consumer would see after
 * expanding every `$ref` (`dereferenced`). The documentation does not say which
 * of the two the provider applies, so a raw PASS is a necessary, not a
 * sufficient, condition for acceptance.
 */
export const PROVIDER_SCHEMA_LIMITS = Object.freeze({
	enumValues: 1000,
	/** Applies to a single enum with more than `largeEnumThreshold` values. */
	largeEnumChars: 15_000,
	largeEnumThreshold: 250,
	totalStringLength: 120_000,
	objectProperties: 5000,
	nestingDepth: 10,
});

export interface SchemaBudget {
	/** Literal enum values in the serialized document. */
	rawEnumValues: number;
	/** Enum values after expanding every `$ref` (conservative). */
	dereferencedEnumValues: number;
	enumProperties: number;
	/** Largest summed value length of a single enum with more than `largeEnumThreshold` values (0 when none). */
	largeEnumChars: number;
	/** Property names + definition names + enum values + const values, summed over the raw document. */
	totalStringLength: number;
	objectProperties: number;
	/** Deepest object nesting after `$ref` expansion. */
	nestingDepth: number;
	rootIsObject: boolean;
	rootHasAnyOf: boolean;
	/** Objects whose `required` is not exactly their property list. */
	objectsWithOptionalProperties: number;
	objectsWithoutAdditionalPropertiesFalse: number;
	unsupportedKeywords: string[];
	/** Enum arrays whose values are all anchor ids (`s0001`…) — the request contract wants exactly one. */
	anchorEnumOccurrences: number;
	/** `anchorId` properties that carry an inline schema instead of a `$ref`. */
	anchorSitesWithoutRef: number;
	/** `anchorId` properties resolved through a `$ref`. */
	anchorSitesWithRef: number;
	definitionNames: string[];
	bytes: number;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

function resolveRef(root: Node, ref: string): Node | null {
	if (!ref.startsWith("#/")) return null;
	let node: unknown = root;
	for (const segment of ref.slice(2).split("/")) {
		if (!isNode(node)) return null;
		node = node[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
	}
	return isNode(node) ? node : null;
}

function isAnchorEnum(values: unknown[]): boolean {
	return values.length > 0 && values.every((v) => typeof v === "string" && ANCHOR_ID_PATTERN.test(v));
}

export function measureSchemaBudget(schema: unknown): SchemaBudget {
	const root = isNode(schema) ? schema : {};
	const allowed = new Set<string>(STRICT_STRUCTURED_OUTPUT_KEYWORDS);
	const unsupported = new Set<string>();
	const budget: SchemaBudget = {
		rawEnumValues: 0,
		dereferencedEnumValues: 0,
		enumProperties: 0,
		largeEnumChars: 0,
		totalStringLength: 0,
		objectProperties: 0,
		nestingDepth: 0,
		rootIsObject: root.type === "object",
		rootHasAnyOf: "anyOf" in root,
		objectsWithOptionalProperties: 0,
		objectsWithoutAdditionalPropertiesFalse: 0,
		unsupportedKeywords: [],
		anchorEnumOccurrences: 0,
		anchorSitesWithoutRef: 0,
		anchorSitesWithRef: 0,
		definitionNames: isNode(root.$defs) ? Object.keys(root.$defs) : [],
		bytes: JSON.stringify(schema).length,
	};

	// Raw pass: literal content of the document, keyword usage, object shape.
	const raw = (node: unknown, underNames: boolean) => {
		if (Array.isArray(node)) {
			for (const item of node) raw(item, false);
			return;
		}
		if (!isNode(node)) return;
		if (underNames) {
			// `node` is a `properties` or `$defs` map: keys are names, values are schemas.
			for (const [name, value] of Object.entries(node)) {
				budget.totalStringLength += name.length;
				if (name === "anchorId" && isNode(value)) {
					if (typeof value.$ref === "string") budget.anchorSitesWithRef += 1;
					else budget.anchorSitesWithoutRef += 1;
				}
				raw(value, false);
			}
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			if (!allowed.has(key)) unsupported.add(key);
			if (key === "enum" && Array.isArray(value)) {
				budget.enumProperties += 1;
				budget.rawEnumValues += value.length;
				const chars = value.reduce<number>((n, v) => n + String(v).length, 0);
				budget.totalStringLength += chars;
				if (value.length > PROVIDER_SCHEMA_LIMITS.largeEnumThreshold) {
					budget.largeEnumChars = Math.max(budget.largeEnumChars, chars);
				}
				if (isAnchorEnum(value)) budget.anchorEnumOccurrences += 1;
				continue;
			}
			if (key === "const") {
				budget.totalStringLength += String(value).length;
				continue;
			}
			if (key === "properties" && isNode(value)) {
				budget.objectProperties += Object.keys(value).length;
				raw(value, true);
				continue;
			}
			if (key === "$defs" && isNode(value)) {
				raw(value, true);
				continue;
			}
			raw(value, false);
		}
		if (node.type === "object") {
			const props = isNode(node.properties) ? Object.keys(node.properties) : [];
			const required = Array.isArray(node.required) ? node.required : [];
			if (props.length !== required.length || props.some((p) => !required.includes(p))) {
				budget.objectsWithOptionalProperties += 1;
			}
			if (node.additionalProperties !== false) budget.objectsWithoutAdditionalPropertiesFalse += 1;
		}
	};
	raw(root, false);
	budget.unsupportedKeywords = [...unsupported].sort();

	// Dereferenced pass: expand every `$ref` (bounded against cycles) for the conservative enum count and the object depth.
	const expand = (node: unknown, depth: number, seen: string[]) => {
		if (Array.isArray(node)) {
			for (const item of node) expand(item, depth, seen);
			return;
		}
		if (!isNode(node)) return;
		if (typeof node.$ref === "string") {
			if (seen.includes(node.$ref) || seen.length > 64) return;
			const target = resolveRef(root, node.$ref);
			if (target) expand(target, depth, [...seen, node.$ref]);
			return;
		}
		const objectDepth = node.type === "object" ? depth + 1 : depth;
		budget.nestingDepth = Math.max(budget.nestingDepth, objectDepth);
		for (const [key, value] of Object.entries(node)) {
			if (key === "$defs") continue;
			if (key === "enum" && Array.isArray(value)) {
				budget.dereferencedEnumValues += value.length;
				continue;
			}
			if (key === "properties" && isNode(value)) {
				for (const child of Object.values(value)) expand(child, objectDepth, seen);
				continue;
			}
			expand(value, objectDepth, seen);
		}
	};
	expand(root, 0, []);
	return budget;
}

export interface SchemaBudgetViolation {
	rule: string;
	actual: number | string | boolean;
	limit: number | string | boolean;
}

/** Every documented limit and contract requirement the raw serialized schema breaks; empty when it passes. */
export function schemaBudgetViolations(schema: unknown): SchemaBudgetViolation[] {
	const b = measureSchemaBudget(schema);
	const out: SchemaBudgetViolation[] = [];
	const check = (rule: string, ok: boolean, actual: number | string | boolean, limit: number | string | boolean) => {
		if (!ok) out.push({ rule, actual, limit });
	};
	check(
		"enum-values",
		b.rawEnumValues <= PROVIDER_SCHEMA_LIMITS.enumValues,
		b.rawEnumValues,
		PROVIDER_SCHEMA_LIMITS.enumValues,
	);
	check(
		"large-enum-chars",
		b.largeEnumChars <= PROVIDER_SCHEMA_LIMITS.largeEnumChars,
		b.largeEnumChars,
		PROVIDER_SCHEMA_LIMITS.largeEnumChars,
	);
	check(
		"total-string-length",
		b.totalStringLength <= PROVIDER_SCHEMA_LIMITS.totalStringLength,
		b.totalStringLength,
		PROVIDER_SCHEMA_LIMITS.totalStringLength,
	);
	check(
		"object-properties",
		b.objectProperties <= PROVIDER_SCHEMA_LIMITS.objectProperties,
		b.objectProperties,
		PROVIDER_SCHEMA_LIMITS.objectProperties,
	);
	check(
		"nesting-depth",
		b.nestingDepth <= PROVIDER_SCHEMA_LIMITS.nestingDepth,
		b.nestingDepth,
		PROVIDER_SCHEMA_LIMITS.nestingDepth,
	);
	check("root-object", b.rootIsObject, b.rootIsObject, true);
	check("root-anyof", !b.rootHasAnyOf, b.rootHasAnyOf, false);
	check("all-required", b.objectsWithOptionalProperties === 0, b.objectsWithOptionalProperties, 0);
	check(
		"additional-properties-false",
		b.objectsWithoutAdditionalPropertiesFalse === 0,
		b.objectsWithoutAdditionalPropertiesFalse,
		0,
	);
	check("unsupported-keywords", b.unsupportedKeywords.length === 0, b.unsupportedKeywords.join(","), "");
	check("anchor-enum-once", b.anchorEnumOccurrences === 1, b.anchorEnumOccurrences, 1);
	check("anchor-sites-by-ref", b.anchorSitesWithoutRef === 0, b.anchorSitesWithoutRef, 0);
	return out;
}

/** Fails closed on the first schema that breaks a documented provider limit or the request contract. */
export function assertProviderSchemaBudget(schema: unknown): SchemaBudget {
	const violations = schemaBudgetViolations(schema);
	if (violations.length > 0) {
		throw new Error(
			`provider schema budget exceeded: ${violations.map((v) => `${v.rule} ${v.actual} (limit ${v.limit})`).join("; ")}`,
		);
	}
	return measureSchemaBudget(schema);
}
