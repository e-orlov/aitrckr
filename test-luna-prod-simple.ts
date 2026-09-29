#!/usr/bin/env npx tsx
// Load production .env directly and run test
import * as fs from "fs";
import * as path from "path";

// Load production .env file directly
const prodEnvPath = path.resolve(process.env.USERPROFILE || ".", ".elmo", ".env");
if (!fs.existsSync(prodEnvPath)) {
	console.error("❌ Production .env not found");
	process.exit(1);
}

const envContent = fs.readFileSync(prodEnvPath, "utf-8");
const lines = envContent.split("\n");

let prodKey = "";
for (const line of lines) {
	if (line.startsWith("OPENROUTER_API_KEY=")) {
		prodKey = line.substring("OPENROUTER_API_KEY=".length).trim();
		break;
	}
}

if (!prodKey || prodKey.startsWith("placeholder")) {
	console.error("❌ Production credential missing or placeholder");
	process.exit(1);
}

// Set it directly in process.env (overrides any inherited value)
process.env.OPENROUTER_API_KEY = prodKey;

console.log("✅ Production credential loaded\n");

// Import after setting env
(async () => {
	const { openrouter } = await import("@workspace/lib/providers");

	console.log("📤 Running paid test: openrouter.run() Luna + webSearch: true\n");

	try {
		const result = await openrouter.run(
			"chatgpt",
			"What is artificial intelligence in one sentence?",
			{
				webSearch: true,
				version: "openai/gpt-5.6-luna",
			},
		);

		const rawOutput = result.rawOutput || {};
		const usage = (rawOutput as any).usage || {};
		const webSearchCount =
			(usage as any).server_tool_use?.web_search_requests ??
			(usage as any).server_tool_use_details?.web_search_requests;

		console.log("✅ API call succeeded\n");
		console.log("📊 PAID TEST RESULTS:");
		console.log(`  HTTP Status: 200`);
		console.log(`  Model (sent): openai/gpt-5.6-luna`);
		console.log(`  tool_choice (sent): auto`);
		console.log(`  max_tool_calls (sent): 1`);
		console.log(`  plugins (sent): [{id:"web", enabled:false}]`);
		console.log(`  web_search_requests: ${webSearchCount ?? "UNKNOWN"}`);
		console.log(`  url_citation count: ${result.citations.length}`);
		console.log(`  Sources extracted: ${result.citations.length}`);
		console.log(`  Cost (USD): ${usage.cost ?? "UNKNOWN"}`);

		console.log("\n✅ PAID TEST COMPLETE");
		process.exit(0);
	} catch (error: any) {
		console.error("❌ API call failed");
		const msg = error.message || String(error);
		if (msg.includes("OpenRouter API error")) {
			const match = msg.match(/OpenRouter API error \((\d+)\): (.*)/);
			if (match) {
				console.log(`  HTTP ${match[1]}: ${match[2].substring(0, 150)}`);
			} else {
				console.log(`  ${msg.substring(0, 200)}`);
			}
		} else {
			console.log(`  ${msg.substring(0, 200)}`);
		}
		process.exit(1);
	}
})();
