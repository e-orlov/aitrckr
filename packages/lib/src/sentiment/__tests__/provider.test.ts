/**
 * CT-SNT-002 / B1 — the production resolver contract. With every direct LLM
 * key configured and the general research override pointing elsewhere,
 * sentiment must still resolve OpenRouter and send `openai/gpt-5-mini` with
 * strict structured output and the web-search server tool. The only network
 * call is a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveResearchProvider } from "../../providers/research";
import { classifySentiment } from "../classifier";
import { resolveSentimentProvider, SentimentProviderError } from "../provider";
import { SENTIMENT_MODEL, SENTIMENT_PROVIDER_ID, type SentimentCandidate } from "../types";

const answer = "Arvo ist empfehlenswert.";
const candidates: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] },
];
const goodAnswer = {
	entities: [
		{
			key: "brand",
			score: 80,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "Arvo ist empfehlenswert.", polarity: "positive" }],
			aspects: [],
		},
	],
};

function configureEveryProvider() {
	vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
	vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
	vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
	vi.stubEnv("MISTRAL_API_KEY", "mistral-test");
	vi.stubEnv("APP_URL", "http://localhost:1515");
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("CT-SNT-002 sentiment provider lock", () => {
	it("resolves OpenRouter although the general research preference picks direct OpenAI", () => {
		configureEveryProvider();
		vi.stubEnv("ONBOARDING_LLM_TARGET", "");
		expect(resolveResearchProvider().id).toBe("openai-api");
		expect(resolveSentimentProvider().id).toBe(SENTIMENT_PROVIDER_ID);
	});

	it("ignores ONBOARDING_LLM_TARGET even when it names Anthropic or the stub", () => {
		configureEveryProvider();
		vi.stubEnv("ONBOARDING_LLM_TARGET", "claude:anthropic-api");
		expect(resolveResearchProvider().id).toBe("anthropic-api");
		expect(resolveSentimentProvider().id).toBe("openrouter");
		vi.stubEnv("ONBOARDING_LLM_TARGET", "stub:stub");
		expect(resolveResearchProvider().id).toBe("stub");
		expect(resolveSentimentProvider().id).toBe("openrouter");
	});

	it("fails closed without an OpenRouter key instead of falling back to another provider", () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
		expect(() => resolveSentimentProvider()).toThrow(SentimentProviderError);
		expect(() => resolveSentimentProvider()).toThrow(/OPENROUTER_API_KEY/);
	});

	it("sends exactly one OpenRouter request: gpt-5-mini, strict json_schema, web-search server tool", async () => {
		configureEveryProvider();
		vi.stubEnv("ONBOARDING_LLM_TARGET", "claude:anthropic-api");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({
				model: "openai/gpt-5-mini-2025-08-07",
				choices: [{ message: { content: JSON.stringify(goodAnswer) } }],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await classifySentiment({ answerBody: answer, candidates });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("openrouter.ai");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.model).toBe(SENTIMENT_MODEL);
		expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
		expect(body.tools).toEqual([
			expect.objectContaining({
				type: "openrouter:web_search",
				parameters: expect.objectContaining({ engine: "native" }),
			}),
		]);
		expect(body.tool_choice).toBe("required");
		expect(JSON.stringify(body)).not.toMatch(/luna|gpt-4|claude/i);
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
		expect(result.provider).toBe("openrouter");
		expect(result.model).toBe(SENTIMENT_MODEL);
		expect(result.webSearch).toBe(true);
		expect(result.entities[0].evidence[0]).toMatchObject({ start: 0, end: 24, polarity: "positive" });
	});
});
