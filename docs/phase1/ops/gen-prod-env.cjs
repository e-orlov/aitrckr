// Phase 1: generate the production (or production-like) Elmo config dir —
// wizard-equivalent .env + elmo.yaml, mirroring apps/cli/src/index.ts at
// commit b3bea1e (the interactive wizard needs a PTY Windows lacks; see
// gen-test-env.cjs for the same approach on the test stack).
//
// Two modes, decided by whether <configDir>/.env already exists:
//   - first run: write a fresh .env (new secrets, provider key placeholder)
//     and elmo.yaml;
//   - repin: the existing .env is operator-owned state and is never rewritten
//     (not even byte-normalized); it is only checked for the required keys,
//     and only elmo.yaml is regenerated with the requested image tag.
// Nothing this script prints ever contains a value from .env.
//
// Usage: node gen-prod-env.cjs [configDir] [imageTag]
// (defaults: %USERPROFILE%\.elmo, g<short HEAD sha>). Images are pinned to the
// deployed commit — no `latest` in production; deploy = build → docker tag →
// compose up (see runbook).
const { execSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fail = (message) => {
	console.error(`gen-prod-env: ${message}`);
	process.exit(1);
};

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const rawDir =
	process.argv.length > 2 ? process.argv[2] : path.join(process.env.USERPROFILE || os.homedir(), ".elmo");
if (!rawDir || !rawDir.trim()) fail("config dir must not be empty");
const configDir = path.resolve(rawDir);
// A config dir is a dedicated folder; refuse anything that would spray .env/elmo.yaml somewhere shared.
for (const forbidden of [path.parse(configDir).root, os.homedir(), repoRoot]) {
	if (path.resolve(forbidden) === configDir) fail(`refusing to use ${forbidden} as a config dir`);
}

const imageTag =
	process.argv.length > 3
		? process.argv[3]
		: `g${execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim()}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(imageTag)) fail("image tag must be a plain docker tag");
if (imageTag === "latest") fail("refusing the floating tag latest — pin the deployed commit");
const v = "0.2.19";

const envPath = path.join(configDir, ".env");
const yamlPath = path.join(configDir, "elmo.yaml");
const REQUIRED_KEYS = [
	"DEPLOYMENT_MODE",
	"VITE_DEPLOYMENT_MODE",
	"DEPLOYMENT_ID",
	"BETTER_AUTH_SECRET",
	"ELMO_ENCRYPTION_KEY",
	"APP_NAME",
	"APP_ICON",
	"VITE_APP_NAME",
	"VITE_APP_ICON",
	"DATABASE_URL",
	"OPENROUTER_API_KEY",
	"SCRAPE_TARGETS",
	"RUNS_PER_PROMPT",
	"DEFAULT_DELAY_HOURS",
	"DISABLE_TELEMETRY",
	"APP_URL",
	"VITE_APP_URL",
];

/**
 * Key inventory of an existing .env: how often each key is defined, plus the
 * 1-based numbers of lines that are neither blank, comment nor KEY=value.
 * Values are never retained.
 */
function inventory(text) {
	const counts = new Map();
	const malformed = [];
	text.split(/\r?\n/).forEach((line, index) => {
		if (!line.trim() || line.trimStart().startsWith("#")) return;
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
		if (!m) {
			malformed.push(index + 1);
			return;
		}
		counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
	});
	return { counts, malformed };
}

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
	OPENROUTER_API_KEY: "REPLACE_WITH_YOUR_OPENROUTER_KEY",
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
    image: elmo-db-migrate:${imageTag}
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
    image: elmo-web:${imageTag}
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
    image: elmo-worker:${imageTag}
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

/** Write through a sibling temp file so a failure never leaves a truncated target. */
function writeAtomically(target, content) {
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, target);
}

if (fs.existsSync(envPath)) {
	const { counts, malformed } = inventory(fs.readFileSync(envPath, "utf8"));
	const problems = [];
	for (const key of REQUIRED_KEYS) {
		const n = counts.get(key) ?? 0;
		if (n === 0) problems.push(`missing ${key}`);
		if (n > 1) problems.push(`duplicate ${key}`);
	}
	if (malformed.length > 0) problems.push(`malformed line(s) ${malformed.join(", ")}`);
	if (problems.length > 0) fail(`existing .env is not usable, nothing written: ${problems.join("; ")}`);
	writeAtomically(yamlPath, yaml);
	console.log(`kept ${envPath} (${counts.size} keys, unchanged); wrote elmo.yaml pinned to ${imageTag}`);
} else {
	fs.mkdirSync(configDir, { recursive: true });
	writeAtomically(envPath, `${lines.join("\n")}\n`);
	writeAtomically(yamlPath, yaml);
	console.log(`written ${configDir}: .env (${lines.length} lines, key PLACEHOLDER) + elmo.yaml pinned to ${imageTag}`);
}
