import { z } from "zod";

/**
 * The one serialisation of a Zod schema into the JSON Schema sent as a strict
 * structured-output contract. Every provider request and every offline check
 * of "the schema the provider sees" must go through this function so that the
 * budget verifiers measure exactly what is sent. A Zod instance used in more
 * than one place is emitted once under `$defs` and referenced everywhere else,
 * so a large per-request enum (the sentiment anchor ids) is counted once by a
 * consumer that reads the literal document.
 */
export function toStructuredOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema, { reused: "ref" }) as Record<string, unknown>;
}
