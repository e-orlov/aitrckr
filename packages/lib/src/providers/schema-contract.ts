import type { z } from "zod";
import { toStructuredOutputJsonSchema } from "./json-schema";

/**
 * Keywords the strict structured-output mode of the OpenAI-compatible
 * providers accepts (https://developers.openai.com/api/docs/guides/structured-outputs,
 * "Supported schemas"): the structural keywords, `anyOf` inside a property,
 * `enum`/`const`, and the documented per-type constraints for strings
 * (`pattern`, `format`, `minLength`, `maxLength`), numbers (`minimum`,
 * `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) and arrays
 * (`minItems`, `maxItems`). The composition keywords the documentation lists
 * as unsupported (`allOf`, `not`, `if`/`then`/`else`, `dependentRequired`,
 * `dependentSchemas`, `oneOf`, `patternProperties`) are deliberately absent.
 * The root itself must be a plain object.
 */
export const STRICT_STRUCTURED_OUTPUT_KEYWORDS = [
	"$schema",
	"$defs",
	"$ref",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"enum",
	"const",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"description",
	"title",
] as const;

/** Documented limits of strict structured outputs, measured on the serialized document. */
export const STRICT_STRUCTURED_OUTPUT_LIMITS = Object.freeze({
	enumValues: 1000,
	/** Applies to a single enum with more than `largeEnumThreshold` values. */
	largeEnumChars: 15_000,
	largeEnumThreshold: 250,
	totalStringLength: 120_000,
	objectProperties: 5000,
	nestingDepth: 10,
});

export interface StructuredOutputSchemaViolation {
	rule: string;
	actual: number | string | boolean;
	limit: number | string | boolean;
	/** JSON-pointer-like location of the first offending node, when it is a single node. */
	at?: string;
}

/**
 * A request schema that the provider would refuse before generating anything.
 * Thrown before any network operation, so the request was never sent, nothing
 * was charged and no generation id exists. The message names only rules and
 * counts — never the prompt, the schema's enum values or a credential.
 */
export class StructuredOutputSchemaError extends Error {
	readonly violations: readonly StructuredOutputSchemaViolation[];
	/** Always false: the guard runs strictly before the request could leave. */
	readonly requestSent = false as const;

	constructor(violations: readonly StructuredOutputSchemaViolation[]) {
		super(
			`structured output schema rejected before request: ${violations
				.map((v) => `${v.rule} ${String(v.actual)} (limit ${String(v.limit)})${v.at ? ` at ${v.at}` : ""}`)
				.join("; ")}`,
		);
		this.name = "StructuredOutputSchemaError";
		this.violations = violations;
	}
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

interface Measure {
	rawEnumValues: number;
	largeEnumChars: number;
	totalStringLength: number;
	objectProperties: number;
	nestingDepth: number;
	unsupportedKeywords: Map<string, string>;
	optionalPropertyObjects: string[];
	openObjects: string[];
}

/** Literal pass over the serialized document: keywords, enum budgets, names and object shape. */
class LiteralPass {
	private readonly allowed = new Set<string>(STRICT_STRUCTURED_OUTPUT_KEYWORDS);
	constructor(private readonly m: Measure) {}

	walk(node: unknown, path: string): void {
		if (Array.isArray(node)) {
			for (const [i, item] of node.entries()) this.walk(item, `${path}[${i}]`);
			return;
		}
		if (!isNode(node)) return;
		for (const [key, value] of Object.entries(node)) this.keyword(key, value, path);
		this.objectShape(node, path);
	}

	private keyword(key: string, value: unknown, path: string): void {
		if (!this.allowed.has(key) && !this.m.unsupportedKeywords.has(key))
			this.m.unsupportedKeywords.set(key, path || "#");
		if (key === "enum" && Array.isArray(value)) {
			this.enum(value);
		} else if (key === "const") {
			this.m.totalStringLength += String(value).length;
		} else if ((key === "properties" || key === "$defs") && isNode(value)) {
			if (key === "properties") this.m.objectProperties += Object.keys(value).length;
			for (const [name, child] of Object.entries(value)) {
				this.m.totalStringLength += name.length;
				this.walk(child, `${path}/${key}/${name}`);
			}
		} else {
			this.walk(value, `${path}/${key}`);
		}
	}

	private enum(values: unknown[]): void {
		const L = STRICT_STRUCTURED_OUTPUT_LIMITS;
		this.m.rawEnumValues += values.length;
		const chars = values.reduce<number>((n, v) => n + String(v).length, 0);
		this.m.totalStringLength += chars;
		if (values.length > L.largeEnumThreshold) this.m.largeEnumChars = Math.max(this.m.largeEnumChars, chars);
	}

	private objectShape(node: Node, path: string): void {
		if (node.type !== "object") return;
		const props = isNode(node.properties) ? Object.keys(node.properties) : [];
		const required = Array.isArray(node.required) ? node.required : [];
		if (props.length !== required.length || props.some((p) => !required.includes(p))) {
			this.m.optionalPropertyObjects.push(path || "#");
		}
		if (node.additionalProperties !== false) this.m.openObjects.push(path || "#");
	}
}

/** The child schemas of a node with `$defs` and `enum` skipped and `properties` flattened to its values. */
function childSchemas(node: Node): unknown[] {
	return Object.entries(node)
		.filter(([key]) => key !== "$defs" && key !== "enum")
		.map(([key, value]) => (key === "properties" && isNode(value) ? Object.values(value) : value));
}

/** Follows a `$ref`; null when it is unresolvable, cyclic or too deep. */
function followRef(root: Node, ref: string, seen: readonly string[]): { target: Node; seen: string[] } | null {
	if (seen.includes(ref) || seen.length > 64) return null;
	const target = resolveRef(root, ref);
	return target ? { target, seen: [...seen, ref] } : null;
}

/** Object nesting depth with every `$ref` expanded, bounded against cycles. */
class DepthPass {
	constructor(
		private readonly root: Node,
		private readonly m: Measure,
	) {}

	visit(node: unknown, current: number, seen: readonly string[]): void {
		if (Array.isArray(node)) {
			for (const item of node) this.visit(item, current, seen);
			return;
		}
		if (isNode(node)) this.visitNode(node, current, seen);
	}

	private visitNode(node: Node, current: number, seen: readonly string[]): void {
		if (typeof node.$ref === "string") {
			const next = followRef(this.root, node.$ref, seen);
			if (next) this.visit(next.target, current, next.seen);
			return;
		}
		const depth = node.type === "object" ? current + 1 : current;
		this.m.nestingDepth = Math.max(this.m.nestingDepth, depth);
		this.visit(childSchemas(node), depth, seen);
	}
}

const hasRootUnion = (root: Node): boolean => "anyOf" in root || "oneOf" in root || "allOf" in root;

type Rule = [string, boolean, number | string | boolean, number | string | boolean, string?];

function rulesFor(root: Node, m: Measure): Rule[] {
	const L = STRICT_STRUCTURED_OUTPUT_LIMITS;
	return [
		["root-object", root.type === "object", String(root.type ?? "none"), "object"],
		["root-anyof", !hasRootUnion(root), hasRootUnion(root), false],
		[
			"all-required",
			m.optionalPropertyObjects.length === 0,
			m.optionalPropertyObjects.length,
			0,
			m.optionalPropertyObjects[0],
		],
		["additional-properties-false", m.openObjects.length === 0, m.openObjects.length, 0, m.openObjects[0]],
		[
			"unsupported-keywords",
			m.unsupportedKeywords.size === 0,
			[...m.unsupportedKeywords.keys()].sort().join(","),
			"",
			m.unsupportedKeywords.values().next().value,
		],
		["enum-values", m.rawEnumValues <= L.enumValues, m.rawEnumValues, L.enumValues],
		["large-enum-chars", m.largeEnumChars <= L.largeEnumChars, m.largeEnumChars, L.largeEnumChars],
		["total-string-length", m.totalStringLength <= L.totalStringLength, m.totalStringLength, L.totalStringLength],
		["object-properties", m.objectProperties <= L.objectProperties, m.objectProperties, L.objectProperties],
		["nesting-depth", m.nestingDepth <= L.nestingDepth, m.nestingDepth, L.nestingDepth],
	];
}

/**
 * Every rule of the strict subset the provider enforces on the exact JSON
 * Schema document that would be placed in `response_format`: an object root
 * without a root union, every object closed (`additionalProperties: false`)
 * with every property required, only supported keywords, and the documented
 * size limits. Nested `anyOf` is allowed. Empty when the schema is acceptable.
 */
export function structuredOutputSchemaViolations(schema: unknown): StructuredOutputSchemaViolation[] {
	const root = isNode(schema) ? schema : {};
	const m: Measure = {
		rawEnumValues: 0,
		largeEnumChars: 0,
		totalStringLength: 0,
		objectProperties: 0,
		nestingDepth: 0,
		unsupportedKeywords: new Map(),
		optionalPropertyObjects: [],
		openObjects: [],
	};
	new LiteralPass(m).walk(root, "");
	new DepthPass(root, m).visit(root, 0, []);
	return rulesFor(root, m)
		.filter(([, ok]) => !ok)
		.map(([rule, , actual, limit, at]) => (at === undefined ? { rule, actual, limit } : { rule, actual, limit, at }));
}

/** Throws {@link StructuredOutputSchemaError} for a serialized document the provider would refuse. */
export function assertStructuredOutputSchema(jsonSchema: unknown): void {
	const violations = structuredOutputSchemaViolations(jsonSchema);
	if (violations.length > 0) throw new StructuredOutputSchemaError(violations);
}

/**
 * The one boundary every structured-output request passes on its way to the
 * network: serialize the Zod schema exactly as the request will carry it,
 * refuse it locally when the provider would refuse it, and hand back the
 * document to place in `response_format`. Providers must call this — and
 * send precisely the returned document — before their first network operation.
 */
export function prepareStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
	const jsonSchema = toStructuredOutputJsonSchema(schema);
	assertStructuredOutputSchema(jsonSchema);
	return jsonSchema;
}
