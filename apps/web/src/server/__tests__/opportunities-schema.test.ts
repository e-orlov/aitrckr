import { prepareStructuredOutputSchema, structuredOutputSchemaViolations } from "@workspace/lib/providers";
import { describe, expect, it, vi } from "vitest";

// Only the production `opportunitiesSchema` symbol is needed. The module also
// declares server functions and imports the auth/database layer, which needs
// a configured environment at load time; those are stood in so the import
// succeeds without one.
vi.mock("@tanstack/react-start", () => {
	const builder = {
		validator: () => builder,
		handler: () => async () => undefined,
	};
	return { createServerFn: () => builder };
});
vi.mock("@/lib/auth/helpers", () => ({
	requireAuthSession: async () => {
		throw new Error("not used");
	},
	requireBrandAccess: async () => {
		throw new Error("not used");
	},
}));
vi.mock("@workspace/lib/db/db", () => ({ db: {} }));

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
