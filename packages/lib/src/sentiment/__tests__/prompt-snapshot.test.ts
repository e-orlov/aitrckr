/**
 * The provider-facing contract, byte for byte: the rendered prompt and the
 * strict JSON schema OpenRouter receives. The canary contract freezes the
 * prompt's SHA-256, so any drift here must be a deliberate change reviewed
 * against these snapshots.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { segmentAnswer } from "../anchors";
import { buildSentimentPrompt } from "../prompt";
import { type SentimentCandidate, sentimentProviderResultSchemaFor } from "../types";

const answer =
	"ARAG ist nicht teuer und bietet einen sehr guten Service.\n\nDie HUK-COBURG ist günstig, aber die Schadenabwicklung dauert lange.  WGV wird nur genannt.";
const candidates: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] },
	{ key: "c-huk", entityType: "competitor", competitorId: "c-huk", name: "HUK-COBURG", aliases: ["HUK"] },
	{ key: "c-wgv", entityType: "competitor", competitorId: "c-wgv", name: "WGV", aliases: [] },
];

describe("CT-SNT-008 provider-facing prompt and schema snapshots", () => {
	it("renders the prompt from anchored segments and stays byte-identical", () => {
		const prompt = buildSentimentPrompt({ answerBody: answer, candidates });
		expect(prompt).toMatchSnapshot();
		expect(createHash("sha256").update(prompt).digest("hex")).toMatchSnapshot();
		// The raw body appears only as numbered segments, never as a second verbatim copy.
		expect(prompt.split("ARAG ist nicht teuer und bietet einen sehr guten Service.").length).toBe(2);
		expect(prompt).toContain("[s0001] ARAG ist nicht teuer und bietet einen sehr guten Service.");
	});

	it("binds the request schema to this answer's anchor ids and this request's entity keys", () => {
		const ids = segmentAnswer(answer).map((anchor) => anchor.id);
		const jsonSchema = z.toJSONSchema(
			sentimentProviderResultSchemaFor(
				ids,
				candidates.map((c) => c.key),
			),
		);
		expect(jsonSchema).toMatchSnapshot();
		const serialized = JSON.stringify(jsonSchema);
		expect(serialized).toContain('"enum":["s0001","s0002","s0003"]');
		expect(serialized).toContain('"enum":["brand","c-huk","c-wgv"]');
		expect(serialized).not.toContain('"quote"');
	});
});
