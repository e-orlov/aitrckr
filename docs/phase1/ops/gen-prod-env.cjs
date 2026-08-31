// Phase 1: generate the production (or production-like) Elmo config dir —
// wizard-equivalent .env + elmo.yaml, mirroring apps/cli/src/index.ts at
// commit b3bea1e (the interactive wizard needs a PTY Windows lacks; see
// gen-test-env.cjs for the same approach on the test stack).
//
// Preserves an existing OPENROUTER_API_KEY, ELMO_ENCRYPTION_KEY, and
// DEPLOYMENT_ID from a prior .env in the target dir: the encryption key must
// survive regeneration or stored provider credentials become unreadable.
//
// Usage: node gen-prod-env.cjs [configDir]   (default %USERPROFILE%\.elmo)
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const configDir = process.argv[2] || path.join(process.env.USERPROFILE, ".elmo");
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const v = "0.2.19";

const envPath = path.join(configDir, ".env");
const prior = {};
if (fs.existsSync(envPath)) {
	for (const l of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
		const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m) prior[m[1]] = m[2];
	}
}
const keep = (name, fallback) =>
	prior[name] && !prior[name].startsWith("REPLACE_WITH") ? prior[name] : fallback;

const header = [
	`# Rendered by elmo ${v} on ${new Date().toISOString()}`,
	"# Run `elmo upgrade` after upgrading the CLI to refresh this file.",
].join("\n");

const env = {
	DEPLOYMENT_MODE: "local",
	VITE_DEPLOYMENT_MODE: "local",
	DEPLOYMENT_ID: keep("DEPLOYMENT_ID", crypto.randomUUID()),
	BETTER_AUTH_SECRET: keep("BETTER_AUTH_SECRET", crypto.randomBytes(32).toString("base64url")),
	ELMO_ENCRYPTION_KEY: keep("ELMO_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64")),
	APP_NAME: "Elmo",
	APP_ICON: "/icons/elmo-icon.svg",
	VITE_APP_NAME: "Elmo",
	VITE_APP_ICON: "/icons/elmo-icon.svg",
	DATABASE_URL: "postgres://postgres:postgres@postgres:5432/elmo",
	OPENROUTER_API_KEY: keep("OPENROUTER_API_KEY", "REPLACE_WITH_YOUR_OPENROUTER_KEY"),
	SCRAPE_TARGETS: "chatgpt:openrouter:openai/gpt-5.6-luna:online",
	// User decisions (master prompt §3.2): one sample per prompt, 24h cadence.
	RUNS_PER_PROMPT: "1",
	DEFAULT_DELAY_HOURS: "24",
	DISABLE_TELEMETRY: "1",
	APP_URL: "http://localhost:1515",
	VITE_APP_URL: "http://localhost:1515",
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

const ctx = repoRoot.replace(/\\/g, "/");
const yaml = `${header}

name: elmo

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: elmo
    volumes:
      - postgres_data:/var/lib/postgresql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 30s
  db-migrate:
    build:
      context: ${ctx}
      dockerfile: docker/Dockerfile
      target: migrate
    environment:
      - DATABASE_URL=postgres://postgres:postgres@postgres:5432/elmo
    depends_on:
      postgres:
        condition: service_healthy
  web:
    build:
      context: ${ctx}
      dockerfile: docker/Dockerfile
      target: web
      args:
        DEPLOYMENT_MODE: local
    env_file:
      - path: .env
        required: true
    ports:
      - "1515:3000"
    depends_on:
      db-migrate:
        condition: service_completed_successfully
  worker:
    build:
      context: ${ctx}
      dockerfile: docker/Dockerfile
      target: worker
      args:
        DEPLOYMENT_MODE: local
    env_file:
      - path: .env
        required: true
    stop_grace_period: 35s
    depends_on:
      db-migrate:
        condition: service_completed_successfully

volumes:
  postgres_data:
`;

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(envPath, lines.join("\n") + "\n");
fs.writeFileSync(path.join(configDir, "elmo.yaml"), yaml);
const keyState = env.OPENROUTER_API_KEY.startsWith("REPLACE_WITH") ? "PLACEHOLDER" : "preserved";
console.log(`written ${configDir}: .env (${lines.length} lines, key ${keyState}) + elmo.yaml`);
