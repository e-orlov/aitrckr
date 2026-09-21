import { prepareStructuredOutputSchema, structuredOutputSchemaViolations } from "@workspace/lib/providers";
import { describe, expect, it, vi } from "vitest";

// `createServerFn` is a Vite-transformed builder; the schema module only needs
// it to exist so the production `opportunitiesSchema` symbol can be imported.
vi.mock("@tanstack/react-start", () => {
	const builder = {
		validator: () => builder,
		handler: () => async () => undefined,
	};
	return { createServerFn: () => builder };
});

import { opportunitiesSchema } from "@/server/opportunities";

describe("the opportunities report schema on the wire", () => {
	it("is the production schema and passes the shared provider contract", () => {
		const json = prepareStructuredOutputSchema(opportunitiesSchema);
		expect(structuredOutputSchemaViolations(json)).toEqual([]);
		expect(json.type).toBe("object");
		expect(json.additionalProperties).toBe(false);
		expect(json.required).toEqual(["summary", "opportunities", "risks"]);
	});
});
