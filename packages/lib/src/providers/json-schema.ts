import { z } from "zod";

/**
 * The one serialisation of a Zod schema into the JSON Schema sent as a strict
 * structured-output contract. Every provider request and every offline check
 * of "the schema the provider sees" must go through this function so that the
 * budget verifiers measure exactly what is sent.
 */
export function toStructuredOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>;
}
