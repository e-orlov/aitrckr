import {
	STRICT_STRUCTURED_OUTPUT_KEYWORDS,
	STRICT_STRUCTURED_OUTPUT_LIMITS,
	structuredOutputSchemaViolations,
} from "../providers/schema-contract";
import { ANCHOR_ID_PATTERN } from "./types";

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
export const PROVIDER_SCHEMA_LIMITS = STRICT_STRUCTURED_OUTPUT_LIMITS;

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

/**
 * An `anchorId` site references the shared definition either directly or as a
 * nullable wrapper (`anyOf` of the `$ref` and `null`); an inline enum is not.
 */
function refersToDefinition(site: Node): boolean {
	if (typeof site.$ref === "string") return true;
	if (!Array.isArray(site.anyOf)) return false;
	return site.anyOf.every((branch) => isNode(branch) && (typeof branch.$ref === "string" || branch.type === "null"));
}

function isAnchorEnum(values: unknown[]): boolean {
	return values.length > 0 && values.every((v) => typeof v === "string" && ANCHOR_ID_PATTERN.test(v));
}

function emptyBudget(root: Node, schema: unknown): SchemaBudget {
	return {
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
}

/** Literal pass over the serialized document: enums, names, keywords and object shape. */
class RawPass {
	readonly unsupported = new Set<string>();
	constructor(
		private readonly budget: SchemaBudget,
		private readonly allowed: ReadonlySet<string>,
	) {}

	/** `map` is a `properties` or `$defs` object: keys are names, values are schemas. */
	names(map: Node, kind: "properties" | "$defs"): void {
		for (const [name, value] of Object.entries(map)) {
			this.budget.totalStringLength += name.length;
			if (kind === "properties" && name === "anchorId" && isNode(value)) {
				if (refersToDefinition(value)) this.budget.anchorSitesWithRef += 1;
				else this.budget.anchorSitesWithoutRef += 1;
			}
			this.schema(value);
		}
	}

	enum(values: unknown[]): void {
		this.budget.enumProperties += 1;
		this.budget.rawEnumValues += values.length;
		const chars = values.reduce<number>((n, v) => n + String(v).length, 0);
		this.budget.totalStringLength += chars;
		if (values.length > PROVIDER_SCHEMA_LIMITS.largeEnumThreshold) {
			this.budget.largeEnumChars = Math.max(this.budget.largeEnumChars, chars);
		}
		if (isAnchorEnum(values)) this.budget.anchorEnumOccurrences += 1;
	}

	objectShape(node: Node): void {
		if (node.type !== "object") return;
		const props = isNode(node.properties) ? Object.keys(node.properties) : [];
		const required = Array.isArray(node.required) ? node.required : [];
		if (props.length !== required.length || props.some((p) => !required.includes(p))) {
			this.budget.objectsWithOptionalProperties += 1;
		}
		if (node.additionalProperties !== false) this.budget.objectsWithoutAdditionalPropertiesFalse += 1;
	}

	schema(node: unknown): void {
		if (Array.isArray(node)) {
			for (const item of node) this.schema(item);
			return;
		}
		if (!isNode(node)) return;
		for (const [key, value] of Object.entries(node)) this.keyword(key, value);
		this.objectShape(node);
	}

	private keyword(key: string, value: unknown): void {
		if (!this.allowed.has(key)) this.unsupported.add(key);
		if (key === "enum" && Array.isArray(value)) {
			this.enum(value);
		} else if (key === "const") {
			this.budget.totalStringLength += String(value).length;
		} else if ((key === "properties" || key === "$defs") && isNode(value)) {
			if (key === "properties") this.budget.objectProperties += Object.keys(value).length;
			this.names(value, key);
		} else {
			this.schema(value);
		}
	}
}

/** Follows a `$ref` to its definition; null when it is unresolvable, cyclic or too deep. */
function followRef(root: Node, node: Node, seen: readonly string[]): { target: Node; seen: string[] } | null {
	const ref = node.$ref;
	if (typeof ref !== "string" || seen.includes(ref) || seen.length > 64) return null;
	const target = resolveRef(root, ref);
	return target ? { target, seen: [...seen, ref] } : null;
}

/** Pass over the document with every `$ref` expanded: conservative enum count and object depth. */
function expandPass(root: Node, budget: SchemaBudget): void {
	/** The child schemas of a node, with `$defs` skipped and `properties` flattened to its values. */
	const childrenOf = (node: Node): unknown[] =>
		Object.entries(node)
			.filter(([key]) => key !== "$defs" && key !== "enum")
			.map(([key, value]) => (key === "properties" && isNode(value) ? Object.values(value) : value));
	const visitNode = (node: Node, depth: number, seen: readonly string[]) => {
		const next = typeof node.$ref === "string" ? followRef(root, node, seen) : null;
		if (next) {
			visit(next.target, depth, next.seen);
			return;
		}
		const objectDepth = node.type === "object" ? depth + 1 : depth;
		budget.nestingDepth = Math.max(budget.nestingDepth, objectDepth);
		if (Array.isArray(node.enum)) budget.dereferencedEnumValues += node.enum.length;
		visit(childrenOf(node), objectDepth, seen);
	};
	const visit = (node: unknown, depth: number, seen: readonly string[]) => {
		if (Array.isArray(node)) for (const item of node) visit(item, depth, seen);
		else if (isNode(node)) visitNode(node, depth, seen);
	};
	visit(root, 0, []);
}

/**
 * A copy of the document with every `$ref` replaced by its definition and
 * `$defs` removed — the shape a consumer that expands references would see.
 * Bounded against cycles; used for inspection and for the conservative budget.
 */
export function dereferenceSchema(schema: unknown): unknown {
	const root = isNode(schema) ? schema : {};
	const inline = (node: unknown, seen: readonly string[]): unknown => {
		if (Array.isArray(node)) return node.map((item) => inline(item, seen));
		if (!isNode(node)) return node;
		if (typeof node.$ref === "string") {
			const next = followRef(root, node, seen);
			return next ? inline(next.target, next.seen) : node;
		}
		const out: Node = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "$defs") continue;
			out[key] = key === "properties" && isNode(value) ? inlineMap(value, seen) : inline(value, seen);
		}
		return out;
	};
	const inlineMap = (map: Node, seen: readonly string[]): Node =>
		Object.fromEntries(Object.entries(map).map(([k, v]) => [k, inline(v, seen)]));
	return inline(root, []);
}

export function measureSchemaBudget(schema: unknown): SchemaBudget {
	const root = isNode(schema) ? schema : {};
	const budget = emptyBudget(root, schema);
	const raw = new RawPass(budget, new Set<string>(STRICT_STRUCTURED_OUTPUT_KEYWORDS));
	raw.schema(root);
	budget.unsupportedKeywords = [...raw.unsupported].sort();
	expandPass(root, budget);
	return budget;
}

export interface SchemaBudgetViolation {
	rule: string;
	actual: number | string | boolean;
	limit: number | string | boolean;
}

/**
 * Every rule the raw serialized schema breaks: the provider's strict
 * structured-output contract (the same rules the request boundary enforces
 * before any network operation) plus the sentiment request contract — the
 * per-answer anchor enum appears exactly once, referenced from every site.
 * Empty when it passes.
 */
export function schemaBudgetViolations(schema: unknown): SchemaBudgetViolation[] {
	const b = measureSchemaBudget(schema);
	const contract: [string, boolean, number | string | boolean, number | string | boolean][] = [
		["anchor-enum-once", b.anchorEnumOccurrences === 1, b.anchorEnumOccurrences, 1],
		["anchor-sites-by-ref", b.anchorSitesWithoutRef === 0, b.anchorSitesWithoutRef, 0],
	];
	return [
		...structuredOutputSchemaViolations(schema).map(({ rule, actual, limit }) => ({ rule, actual, limit })),
		...contract.filter(([, ok]) => !ok).map(([rule, , actual, limit]) => ({ rule, actual, limit })),
	];
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
