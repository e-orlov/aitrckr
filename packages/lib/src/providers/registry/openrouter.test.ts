import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WEB_QUERIES_UNAVAILABLE } from "../../constants";
import { API_PROVIDER_MAX_OUTPUT_TOKENS } from "../config";
import { openrouter } from "./openrouter";

function stubFetch(
	overrides: Record<string, unknown> = {},
	init: { ok?: boolean; status?: number; text?: string } = {},
) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: init.ok ?? true,
		status: init.status ?? 200,
		text: async () => init.text ?? "",
		json: async () => ({
			model: "openai/gpt-5-mini-2025-08-07",
			choices: [{ message: { content: "answer" } }],
			...overrides,
		}),
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function sentRequest(fetchMock: ReturnType<typeof vi.fn>): {
	url: string;
	init: RequestInit;
	body: Record<string, unknown>;
} {
	const [url, init] = fetchMock.mock.calls[0];
	return { url, init, body: JSON.parse((init as RequestInit).body as string) };
}

/** Exact server-tool contract every web-enabled OpenRouter request must carry. */
const GERMAN_WEB_SEARCH_TOOLS = [
	{
		type: "openrouter:web_search",
		parameters: {
			engine: "native",
			user_location: { type: "approximate", country: "DE", timezone: "Europe/Berlin" },
		},
	},
];

function expectWebSearchContract(body: Record<string, unknown>) {
	expect(body.tools).toEqual(GERMAN_WEB_SEARCH_TOOLS);
	expect(body.tool_choice).toBe("required");
	expect(body.max_tool_calls).toBe(1);
	expect(body).not.toHaveProperty("plugins");
	expect(body).not.toHaveProperty("web_search_options");
	expect(body).not.toHaveProperty("user_location");
	expect(String(body.model)).not.toMatch(/:online$/);
}

function expectNoWebSearch(rawBody: string) {
	const body = JSON.parse(rawBody);
	expect(body).not.toHaveProperty("tools");
	expect(body).not.toHaveProperty("tool_choice");
	expect(body).not.toHaveProperty("max_tool_calls");
	expect(body).not.toHaveProperty("plugins");
	expect(rawBody).not.toContain("user_location");
	expect(rawBody).not.toContain("country");
	expect(rawBody).not.toContain("timezone");
	expect(rawBody).not.toContain("web_search");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("openrouter run", () => {
	it("requests one native web search biased to Germany on the bare model slug", async () => {
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: true, version: "openai/gpt-5.6-luna" });

		const { url, body } = sentRequest(fetchMock);
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(body.model).toBe("openai/gpt-5.6-luna");
		expect(body.messages).toEqual([{ role: "user", content: "prompt" }]);
		expect(body.max_tokens).toBe(API_PROVIDER_MAX_OUTPUT_TOKENS.openrouter);
		expectWebSearchContract(body);
		expect(Object.keys(body).sort()).toEqual([
			"max_tokens",
			"max_tool_calls",
			"messages",
			"model",
			"tool_choice",
			"tools",
		]);
	});

	it("drops a legacy terminal :online suffix instead of activating search twice", async () => {
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: true, version: "openai/gpt-5.6-luna:online" });

		const { body } = sentRequest(fetchMock);
		expect(body.model).toBe("openai/gpt-5.6-luna");
		expect(body.tools).toHaveLength(1);
		expectWebSearchContract(body);
	});

	it("keeps other model variants when removing the :online flag", async () => {
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: true, version: "meta-llama/llama-4-maverick:free:online" });

		const { body } = sentRequest(fetchMock);
		expect(body.model).toBe("meta-llama/llama-4-maverick:free");
		expectWebSearchContract(body);
	});

	it("sends no web tool, location or tool budget when web search is off", async () => {
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: false, version: "openai/gpt-5.6-luna" });

		const { init, body } = sentRequest(fetchMock);
		expect(body.model).toBe("openai/gpt-5.6-luna");
		expect(body.max_tokens).toBe(API_PROVIDER_MAX_OUTPUT_TOKENS.openrouter);
		expect(body.messages).toEqual([{ role: "user", content: "prompt" }]);
		expectNoWebSearch(init.body as string);
	});

	it("also strips a stray :online when web search is off", async () => {
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: false, version: "openai/gpt-5-mini:online" });

		const { init, body } = sentRequest(fetchMock);
		expect(body.model).toBe("openai/gpt-5-mini");
		expectNoWebSearch(init.body as string);
	});

	it("rejects a target without a version slug before calling the API", async () => {
		const fetchMock = stubFetch();

		await expect(openrouter.run("chatgpt", "prompt", { webSearch: true })).rejects.toThrow(/version slug/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps text, deduplicated citations, model version and web-query marker intact", async () => {
		stubFetch({
			model: "openai/gpt-5.6-luna-2026-05-01",
			choices: [
				{
					finish_reason: "stop",
					message: {
						content: "Grounded answer",
						annotations: [
							{ type: "url_citation", url_citation: { url: "https://www.example.de/a", title: "Example A" } },
							{ type: "url_citation", url_citation: { url: "https://www.example.de/a", title: "Duplicate" } },
							{ type: "url_citation", url: "https://news.example.com/b", title: "Flat B" },
							{ type: "url_citation", url_citation: { url: "not a url" } },
							{ type: "other", url_citation: { url: "https://ignored.example.com" } },
						],
					},
				},
			],
			usage: { server_tool_use_details: { web_search_requests: 1 } },
		});

		const result = await openrouter.run("chatgpt", "prompt", { webSearch: true, version: "openai/gpt-5.6-luna" });

		expect(result.textContent).toBe("Grounded answer");
		expect(result.modelVersion).toBe("openai/gpt-5.6-luna-2026-05-01");
		expect(result.webQueries).toEqual([WEB_QUERIES_UNAVAILABLE]);
		expect(result.citations).toEqual([
			{ url: "https://www.example.de/a", title: "Example A", domain: "example.de", citationIndex: 0 },
			{ url: "https://news.example.com/b", title: "Flat B", domain: "news.example.com", citationIndex: 1 },
		]);
		expect((result.rawOutput as any).usage.server_tool_use_details.web_search_requests).toBe(1);
	});

	it("falls back to the bare slug as model version and reports no web queries without citations", async () => {
		stubFetch({ model: undefined, choices: [{ message: { content: "plain" } }] });

		const result = await openrouter.run("chatgpt", "prompt", {
			webSearch: true,
			version: "openai/gpt-5.6-luna:online",
		});

		expect(result.modelVersion).toBe("openai/gpt-5.6-luna");
		expect(result.webQueries).toEqual([]);
		expect(result.citations).toEqual([]);
	});

	it("logs a warning when the response stops on the output cap", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		stubFetch({ choices: [{ message: { content: "clipped" }, finish_reason: "length" }] });

		const result = await openrouter.run("chatgpt", "prompt", { webSearch: false, version: "openai/gpt-5-mini" });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("hit the output cap"));
		// Logged, never thrown — the partial answer still flows through.
		expect(result.textContent).toBe("clipped");
	});

	it("surfaces a non-2xx response as an error carrying status and body but no credential", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-secret-value");
		stubFetch({}, { ok: false, status: 400, text: '{"error":{"message":"Invalid tool type"}}' });

		await expect(
			openrouter.run("chatgpt", "prompt", { webSearch: true, version: "openai/gpt-5.6-luna" }),
		).rejects.toSatisfy((error: unknown) => {
			const message = (error as Error).message;
			expect(message).toContain("OpenRouter API error (400)");
			expect(message).toContain("Invalid tool type");
			expect(message).not.toContain("sk-or-secret-value");
			return true;
		});
	});

	it("authenticates with the bearer key and app attribution headers", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-key");
		vi.stubEnv("APP_URL", "http://localhost:1515");
		const fetchMock = stubFetch();

		await openrouter.run("chatgpt", "prompt", { webSearch: true, version: "openai/gpt-5.6-luna" });

		const { init } = sentRequest(fetchMock);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			Authorization: "Bearer sk-or-test-key",
			"Content-Type": "application/json",
			"HTTP-Referer": "http://localhost:1515",
			"X-Title": "Elmo AEO",
		});
	});
});

describe("openrouter runStructuredResearch", () => {
	const schema = z.object({ summary: z.string(), competitors: z.array(z.string()) });
	const structured = { summary: "ok", competitors: ["a", "b"] };

	it("keeps the research model and strict JSON schema while adding the German web search", async () => {
		const fetchMock = stubFetch({ choices: [{ message: { content: JSON.stringify(structured) } }] });

		const result = await openrouter.runStructuredResearch!({ prompt: "research", schema, webSearch: true });

		const { body } = sentRequest(fetchMock);
		expect(body.model).toBe("openai/gpt-5-mini");
		expect(body.messages).toEqual([{ role: "user", content: "research" }]);
		expect(body.response_format).toEqual({
			type: "json_schema",
			json_schema: { name: "research_output", strict: true, schema: z.toJSONSchema(schema) },
		});
		expectWebSearchContract(body);
		expect(body).not.toHaveProperty("max_tokens");
		expect(result).toEqual({ object: structured, modelVersion: "openai/gpt-5-mini" });
	});

	it("defaults to web search when the option is omitted", async () => {
		const fetchMock = stubFetch({ choices: [{ message: { content: JSON.stringify(structured) } }] });

		await openrouter.runStructuredResearch!({ prompt: "research", schema });

		expectWebSearchContract(sentRequest(fetchMock).body);
	});

	it("sends no web tool or location when web search is off and still parses the result", async () => {
		const fetchMock = stubFetch({ choices: [{ message: { content: JSON.stringify(structured) } }] });

		const result = await openrouter.runStructuredResearch!({ prompt: "research", schema, webSearch: false });

		const { init, body } = sentRequest(fetchMock);
		expect(body.model).toBe("openai/gpt-5-mini");
		expect(body.response_format).toMatchObject({ type: "json_schema" });
		expectNoWebSearch(init.body as string);
		expect(result.object).toEqual(structured);
	});

	it("rejects content that does not match the schema", async () => {
		stubFetch({ choices: [{ message: { content: JSON.stringify({ summary: 1 }) } }] });

		await expect(openrouter.runStructuredResearch!({ prompt: "research", schema })).rejects.toThrow();
	});

	it("surfaces a non-2xx response as an error without the credential", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-secret-value");
		stubFetch({}, { ok: false, status: 402, text: "Insufficient credits" });

		await expect(openrouter.runStructuredResearch!({ prompt: "research", schema })).rejects.toSatisfy(
			(error: unknown) => {
				const message = (error as Error).message;
				expect(message).toBe("OpenRouter API error (402): Insufficient credits");
				expect(message).not.toContain("sk-or-secret-value");
				return true;
			},
		);
	});
});
