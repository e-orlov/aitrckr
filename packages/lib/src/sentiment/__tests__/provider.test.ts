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
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
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
		expect(body.max_tokens).toBe(8000);
		expect(body.max_tool_calls).toBe(1);
		expect(body.tools).toEqual([
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "native",
					user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" },
				},
			},
		]);
		expect(Object.keys(body).sort()).toEqual([
			"max_tokens",
			"max_tool_calls",
			"messages",
			"model",
			"response_format",
			"tool_choice",
			"tools",
		]);
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

	it("propagates only safe numeric usage from the OpenRouter response and logs nothing", async () => {
		configureEveryProvider();
		const logs: string[] = [];
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({
					id: "gen-abc",
					model: "openai/gpt-5-mini-2025-08-07",
					choices: [{ message: { content: JSON.stringify(goodAnswer) } }],
					usage: {
						prompt_tokens: 7000,
						completion_tokens: 900,
						completion_tokens_details: { reasoning_tokens: 400 },
						cost: 0.0312,
						server_tool_use: { web_search_requests: 1 },
					},
				}),
			}),
		);
		const result = await classifySentiment({ answerBody: answer, candidates });
		for (const spy of spies) spy.mockRestore();
		expect(result.usage).toEqual({
			inputTokens: 7000,
			outputTokens: 900,
			reasoningTokens: 400,
			costUsd: 0.0312,
			webSearchRequests: 1,
			webSearchRequestsConflict: false,
		});
		expect(result.request).toEqual({
			model: SENTIMENT_MODEL,
			webSearch: true,
			maxToolCalls: 1,
			maxOutputTokens: 8000,
		});
		// The classification carries the bounded verbatim excerpts and the opaque generation id by
		// contract, never the raw payload, provider field names, the prompt, headers or credentials.
		expect(result.generationId).toBe("gen-abc");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toMatch(/sk-or-|Authorization|Bearer|prompt_tokens|server_tool_use|choices/);
		expect(serialized).not.toContain("gpt-5-mini-2025-08-07");
		expect(serialized).not.toContain("You are an analyst");
		expect(logs.join("\n")).not.toMatch(/sk-or-|gen-abc|Bearer/);
		expect(logs.join("\n")).not.toContain(answer);
	});

	it("passes the job abort signal to the OpenRouter fetch and surfaces the abort", async () => {
		configureEveryProvider();
		const controller = new AbortController();
		const fetchMock = vi.fn((_url: string, init: RequestInit) => {
			expect(init.signal).toBe(controller.signal);
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const pending = classifySentiment({ answerBody: answer, candidates }, {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
