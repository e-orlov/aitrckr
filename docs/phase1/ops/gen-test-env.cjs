// Phase 1 helper: reproduce `elmo init --dev` output non-interactively.
// Mirrors apps/cli/src/index.ts (buildEnvFile/formatEnvValue/init env map) at
// commit b3bea1e with the same answers the CI cli-driver gives, because
// script(1) (the PTY wrapper cli-driver.ts needs) does not exist on Windows.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const v = "0.2.19";
const header = [
	`# Rendered by elmo ${v} on ${new Date().toISOString()}`,
	"# Run `elmo upgrade` after upgrading the CLI to refresh this file.",
].join("\n");

const env = {
	DEPLOYMENT_MODE: "local",
	VITE_DEPLOYMENT_MODE: "local",
	DEPLOYMENT_ID: crypto.randomUUID(),
	BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("base64url"),
	ELMO_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
	APP_NAME: "Elmo",
	APP_ICON: "/icons/elmo-icon.svg",
	VITE_APP_NAME: "Elmo",
	VITE_APP_ICON: "/icons/elmo-icon.svg",
	DATABASE_URL: "postgres://postgres:postgres@postgres:5432/elmo",
	ANTHROPIC_API_KEY: "sk-ant-placeholder-not-used",
	OPENAI_API_KEY: "sk-placeholder-not-used",
	DATAFORSEO_LOGIN: "placeholder@e2e.test",
	DATAFORSEO_PASSWORD: "placeholder-not-used",
	SCRAPE_TARGETS: "claude:anthropic-api:claude-sonnet-5,chatgpt:openai-api:gpt-5-mini:online",
	DISABLE_TELEMETRY: "1",
	APP_URL: "http://localhost:3999",
	VITE_APP_URL: "http://localhost:3999",
};

function formatEnvValue(value) {
	if (value === "") return '""';
	if (/[\s#"']/u.test(value)) {
		const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${escaped}"`;
	}
	return value;
}

const lines = [header, "# WARNING: contains secrets. Do not commit.", ""];
for (const [k, val] of Object.entries(env)) lines.push(`${k}=${formatEnvValue(val)}`);
lines.push(
	"",
	"# E2E test overrides (CI parity with .github/workflows/e2e.yaml)",
	"ADMIN_API_KEYS=test-api-key-e2e",
	"ONBOARDING_LLM_TARGET=stub:stub",
	"SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0",
);
fs.writeFileSync(path.join(__dirname, "..", "..", "..", "e2e", ".elmo", ".env"), lines.join("\n") + "\n");
console.log(`written ${lines.length} lines (values hidden)`);
