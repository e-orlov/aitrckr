import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../docs/phase1/ops/gen-prod-env.cjs", import.meta.url));

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

// Visibly fake operator values: nothing here resembles a real secret or host.
const OPERATOR_ENV = `# operator-owned production config (synthetic test fixture)
DEPLOYMENT_MODE=local
VITE_DEPLOYMENT_MODE=local
DEPLOYMENT_ID=fake-deployment-id-0001
BETTER_AUTH_SECRET=FAKE_AUTH_SECRET_NOT_REAL_0001
ELMO_ENCRYPTION_KEY=FAKE_ENCRYPTION_KEY_NOT_REAL_0001
APP_NAME="Elmo Test"
APP_ICON=/icons/elmo-icon.svg
VITE_APP_NAME="Elmo Test"
VITE_APP_ICON=/icons/elmo-icon.svg
DATABASE_URL=postgres://user:fake@postgres:5432/elmo
OPENROUTER_API_KEY=FAKE_PROVIDER_KEY_NOT_REAL_0001

SCRAPE_TARGETS=stub:stub-custom-operator-value
RUNS_PER_PROMPT=7
DEFAULT_DELAY_HOURS=99
DISABLE_TELEMETRY=1
APP_URL=http://custom-operator.example:1999
VITE_APP_URL=http://custom-operator.example:1999
OPERATOR_EXTRA_KEY=kept-by-operator # trailing comment kept verbatim
`;

const SECRET_MARKERS = ["NOT_REAL_0001", "fake-deployment-id-0001", "user:fake@"];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Parsed `KEY=value` pairs of a dotenv file, in file order (duplicates kept). */
function parseEnv(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    });
}

function run(configDir, tag = "gTEST0001") {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, configDir, tag], { encoding: "utf8" });
  return { status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** A fresh disposable config directory; tests remove only what they created. */
function tempDir(t, name = "gen-prod-env-") {
  const dir = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertNoSecretLeak(output) {
  for (const marker of SECRET_MARKERS) assert.doesNotMatch(output, new RegExp(marker));
}

test("CFG-01 first run in an empty directory creates .env and elmo.yaml", (t) => {
  const dir = join(tempDir(t), "cfg");
  const { status, output } = run(dir);
  assert.equal(status, 0, output);
  assert.ok(readFileSync(join(dir, ".env"), "utf8").length > 0);
  assert.ok(readFileSync(join(dir, "elmo.yaml"), "utf8").includes("services:"));
});

test("CFG-02 first-run .env contains every required key exactly once", (t) => {
  const dir = tempDir(t);
  assert.equal(run(dir).status, 0);
  const keys = parseEnv(readFileSync(join(dir, ".env"), "utf8")).map(([k]) => k);
  for (const key of REQUIRED_KEYS) {
    assert.equal(keys.filter((k) => k === key).length, 1, `${key} once`);
  }
});

test("CFG-03 first-run secrets are generated but never printed", (t) => {
  const dir = tempDir(t);
  const { output } = run(dir);
  const env = new Map(parseEnv(readFileSync(join(dir, ".env"), "utf8")));
  for (const key of ["BETTER_AUTH_SECRET", "ELMO_ENCRYPTION_KEY", "DEPLOYMENT_ID"]) {
    const value = env.get(key);
    assert.ok(value && value.length >= 16, `${key} generated`);
    assert.ok(!output.includes(value), `${key} not printed`);
  }
  assert.match(output, /PLACEHOLDER/);
});

test("CFG-04 an existing .env stays byte-for-byte identical after a rerun", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  const before = sha256(join(dir, ".env"));
  const { status, output } = run(dir);
  assert.equal(status, 0, output);
  assert.equal(sha256(join(dir, ".env")), before);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), OPERATOR_ENV);
});

test("CFG-05 operator-controlled values survive exactly", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  assert.equal(run(dir).status, 0);
  const env = new Map(parseEnv(readFileSync(join(dir, ".env"), "utf8")));
  assert.equal(env.get("SCRAPE_TARGETS"), "stub:stub-custom-operator-value");
  assert.equal(env.get("APP_URL"), "http://custom-operator.example:1999");
  assert.equal(env.get("VITE_APP_URL"), "http://custom-operator.example:1999");
  assert.equal(env.get("RUNS_PER_PROMPT"), "7");
  assert.equal(env.get("DEFAULT_DELAY_HOURS"), "99");
});

test("CFG-06 existing secret and identity values survive and never reach stdout/stderr", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  const { status, output } = run(dir);
  assert.equal(status, 0);
  const env = new Map(parseEnv(readFileSync(join(dir, ".env"), "utf8")));
  assert.equal(env.get("BETTER_AUTH_SECRET"), "FAKE_AUTH_SECRET_NOT_REAL_0001");
  assert.equal(env.get("ELMO_ENCRYPTION_KEY"), "FAKE_ENCRYPTION_KEY_NOT_REAL_0001");
  assert.equal(env.get("OPENROUTER_API_KEY"), "FAKE_PROVIDER_KEY_NOT_REAL_0001");
  assert.equal(env.get("DEPLOYMENT_ID"), "fake-deployment-id-0001");
  assertNoSecretLeak(output);
});

test("CFG-07 unknown operator keys and comments survive", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  assert.equal(run(dir).status, 0);
  const text = readFileSync(join(dir, ".env"), "utf8");
  assert.match(text, /^OPERATOR_EXTRA_KEY=kept-by-operator # trailing comment kept verbatim$/m);
  assert.match(text, /^# operator-owned production config/m);
});

test("CFG-08 a config path containing spaces works", (t) => {
  const dir = join(tempDir(t), "elmo config dir");
  mkdirSync(dir);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  const { status, output } = run(dir);
  assert.equal(status, 0, output);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), OPERATOR_ENV);
  assert.match(readFileSync(join(dir, "elmo.yaml"), "utf8"), /image: elmo-web:gTEST0001/);
});

test("CFG-09 the explicit image tag pins web, worker and db-migrate", (t) => {
  const dir = tempDir(t);
  assert.equal(run(dir, "gabc12345").status, 0);
  const yaml = readFileSync(join(dir, "elmo.yaml"), "utf8");
  assert.match(yaml, /^\s+image: elmo-web:gabc12345$/m);
  assert.match(yaml, /^\s+image: elmo-worker:gabc12345$/m);
  assert.match(yaml, /^\s+image: elmo-db-migrate:gabc12345$/m);
});

test("CFG-10 the generated compose file never references latest, and a latest tag is refused", (t) => {
  const dir = tempDir(t);
  assert.equal(run(dir, "gabc12345").status, 0);
  assert.doesNotMatch(readFileSync(join(dir, "elmo.yaml"), "utf8"), /latest/);
  const refused = run(tempDir(t), "latest");
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /latest/);
});

test("CFG-11 repinning to another tag changes only the image lines and the generated header", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  assert.equal(run(dir, "gaaaaaaaa").status, 0);
  const envBefore = sha256(join(dir, ".env"));
  const first = readFileSync(join(dir, "elmo.yaml"), "utf8").split("\n");
  assert.equal(run(dir, "gbbbbbbbb").status, 0);
  const second = readFileSync(join(dir, "elmo.yaml"), "utf8").split("\n");
  assert.equal(sha256(join(dir, ".env")), envBefore);
  assert.equal(first.length, second.length);
  const changed = first.map((line, i) => [line, second[i]]).filter(([a, b]) => a !== b);
  const imageChanges = changed.filter(([a, b]) => a.includes("gaaaaaaaa") && b === a.replace("gaaaaaaaa", "gbbbbbbbb"));
  const headerChanges = changed.filter(([a]) => a.startsWith("# Rendered by elmo"));
  assert.equal(imageChanges.length, 3);
  assert.equal(changed.length - imageChanges.length - headerChanges.length, 0, JSON.stringify(changed));
});

test("CFG-12 a missing required key fails before either file changes", (t) => {
  const dir = tempDir(t);
  const broken = OPERATOR_ENV.replace(/^ELMO_ENCRYPTION_KEY=.*\n/m, "");
  writeFileSync(join(dir, ".env"), broken);
  writeFileSync(join(dir, "elmo.yaml"), "untouched: true\n");
  const { status, output } = run(dir);
  assert.notEqual(status, 0);
  assert.match(output, /ELMO_ENCRYPTION_KEY/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), broken);
  assert.equal(readFileSync(join(dir, "elmo.yaml"), "utf8"), "untouched: true\n");
});

test("CFG-13 a duplicate required key fails before either file changes", (t) => {
  const dir = tempDir(t);
  const broken = `${OPERATOR_ENV}APP_URL=http://second.example\n`;
  writeFileSync(join(dir, ".env"), broken);
  writeFileSync(join(dir, "elmo.yaml"), "untouched: true\n");
  const { status, output } = run(dir);
  assert.notEqual(status, 0);
  assert.match(output, /APP_URL/);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), broken);
  assert.equal(readFileSync(join(dir, "elmo.yaml"), "utf8"), "untouched: true\n");
});

test("CFG-14 failure output names only keys, never values", (t) => {
  const dir = tempDir(t);
  const broken = `${OPERATOR_ENV.replace(/^SCRAPE_TARGETS=.*\n/m, "")}BETTER_AUTH_SECRET=FAKE_SECOND_SECRET_NOT_REAL_0001\nthis line is not a key=value pair\n`;
  writeFileSync(join(dir, ".env"), broken);
  const { status, output } = run(dir);
  assert.notEqual(status, 0);
  assert.match(output, /SCRAPE_TARGETS/);
  assert.match(output, /BETTER_AUTH_SECRET/);
  assertNoSecretLeak(output);
  assert.doesNotMatch(output, /FAKE_SECOND_SECRET/);
  assert.doesNotMatch(output, /custom-operator\.example/);
  assert.doesNotMatch(output, /this line is not a key=value pair/);
});

test("CFG-15 repeated invocation with the same input is idempotent", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, ".env"), OPERATOR_ENV);
  assert.equal(run(dir).status, 0);
  const env1 = sha256(join(dir, ".env"));
  const yaml1 = readFileSync(join(dir, "elmo.yaml"), "utf8").replace(/^# Rendered by elmo.*$/m, "");
  assert.equal(run(dir).status, 0);
  assert.equal(sha256(join(dir, ".env")), env1);
  assert.equal(readFileSync(join(dir, "elmo.yaml"), "utf8").replace(/^# Rendered by elmo.*$/m, ""), yaml1);
});

test("refuses an empty, root or home target directory", () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  for (const target of ["", "/", home]) {
    const { status, output } = spawnSync(process.execPath, [SCRIPT, target, "gTEST0001"], { encoding: "utf8" });
    assert.notEqual(status, 0, `refused ${JSON.stringify(target)}: ${output}`);
  }
});
