# Phase 1 — resume checkpoint (no secrets)

Written 2026-08-29T09:55Z by the installing Claude Code session, immediately before the required session reload (MP §7.C.10). A new session must read the master prompt `ELMO_Phase_1_Claude_Code_Master_Prompt.md` (v2.1) plus this file and continue.

## State

- Working dir: `C:\Users\orlov\Claude-Desktop-Projects\aitrckr` — fork repo materialized; branch `phase1-local-production-setup` at `b3bea1edf722813a110223e57a2baad0bb1c5c0e`; remotes `origin`=e-orlov/aitrckr, `upstream`=elmohq/elmo (0 ahead / 4 behind upstream, no sync).
- Master prompt file is untracked and excluded via `.git/info/exclude`. Never commit it.
- Nothing committed yet; all Phase 1 files exist only in the working tree: `docs/phase1/*` (requirements-matrix, gate-record, prerequisite-report, agent-skills-qualification, agent-skills-LICENSE.txt, this file) and `.claude/skills/{source-driven-development,debugging-and-error-recovery,code-review-and-quality}/`.
- Audit clone (read-only, disposable after GATE-S1): `C:\Users\orlov\Claude-Desktop-Projects\_audit-tmp\agent-skills-audit-readonly` @ `d2c37ef6225dd8726cdd369a8030307f48592d26`.

## Gate status

GATE-L1 PASS, GATE-L2 PASS, GATE-S1 **PASS** (2026-08-29T09:34Z, post-reload session: IT-SKILL-001 + ST-SKILL-001/002/003 all PASS), rest not evaluated. See gate-record.md.

## Progress after reload (2026-08-29T09:34Z, same post-reload session)

- pnpm 11.18.0 activated per-user: `corepack enable --install-directory %LOCALAPPDATA%\corepack-shims` (Program Files EPERM as predicted) + user PATH prepend. Git Bash note: use `cygpath -u` when adding to PATH in sh.
- gh 2.98.0 installed per-user (winget, `--scope user`); binary at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_...\bin\gh.exe`; PATH updated by winget for new shells; NOT authenticated yet.
- Timestamp note: pre-reload doc timestamps were estimates ahead of the real clock; measured `date -u` is authoritative from GATE-S1 on.

## Immediate next steps

1. ~~git identity~~ DONE: repo-local user.name=e-orlov, user.email=6871670+e-orlov@users.noreply.github.com; first commit `12011583` (docs+skills, diff --check clean, secret scan clean).
2. ~~gh auth~~ DONE: web device flow confirmed by user; logged in as e-orlov (keyring, https, scopes gist/read:org/repo); fork push=true verified via API.
3. ~~Docker Desktop~~ DONE: 4.88.1 per-user, engine 29.7.2, Compose v5.4.0, WSL2 backend, terms accepted by user, no sign-in; settings hardened (DockerAI off, DisableUpdate true; K8s/2375/beta off by default); smoke + regression PASS; REQ-PLAT-001 PASS. DEF-001 (stale secrets-engine socket crash on stop→start) fixed and documented in prerequisite-report row 13; `%LOCALAPPDATA%\docker-secrets-engine-stale` to delete after next reboot.
4. MCP decision (MP §7.C): existing session MCP inventory — Claude in Desktop browser-pane tools (preview_*: navigate/click/fill/inspect/screenshot/console/network), terminal reader, session mgmt, scheduled-tasks. Repo has native Playwright E2E. Microsoft Playwright MCP **not installed**: duplicate of already-available browser MCP + repo-native Playwright (MP §7.C.2/§7.C.7 — CLI/native first, no MCP "на всякий случай"); revisit only if browser-pane tools prove insufficient at stage G.
5. ~~Stage D~~ DONE (GATE-R1 baseline PASS, see gate-record + baseline-report): deps installed frozen-lockfile; `.env` + `apps/web/.env` created (dev placeholders, SCRAPE_TARGETS=chatgpt:openrouter:openai/gpt-5.6-luna:online — with openrouter-only targets no other provider keys are required by env validation); dev postgres `aitrckr-dev-postgres` (postgres:18-alpine, 127.0.0.1:5432, volume `aitrckr-dev-pgdata` at `/var/lib/postgresql` — child-path mount breaks on pg18, DEF noted); migrations applied (19 tables); lint/unit/build PASS; Playwright browsers installed. DEF-001 (Docker socket), DEF-002 (CRLF worktree; repo now has local core.autocrlf=false) — both fixed, documented in baseline-report.md.
6. ~~Stages E–F~~ DONE (GATE-B1 PASS, GATE-R2 PASS — see gate-record): test stack `aitrckr-test` built from source and verified (E2E local 39/39, Bruno 54/116, worker E2E 1/1 via stub); env boundaries proven; resources measured (resource-report.md — 7.6 GiB WSL sufficient, no .wslconfig change; disk 75% watch). Test stack layering: COMPOSE_FILE="e2e/.elmo/elmo.yaml;e2e/worker-override.yaml;docs/phase1/ops/test-env.override.yaml" COMPOSE_PATH_SEPARATOR=";" COMPOSE_PROJECT_NAME=aitrckr-test; web :3999, pg :5433; e2e/.elmo regenerable via docs/phase1/ops/gen-test-env.cjs. e2e Playwright needs its own `pnpm -C e2e exec playwright install chromium`. Worker stopped after tests (CI parity); web+postgres left running for stage G.
7. Stage G next: runtime feature inventory (routes, local-mode flags, OpenAPI, schema, queues, UI pages, existing tests, changelog) → feature-test matrix; test via seeded aitrckr-test stack on http://localhost:3999 (admin key test-api-key-e2e; auth state in e2e/playwright/.auth if reused). Then stage H OpenRouter gate (user checkpoints), I, J (crash/idempotency; pg-boss audit), K (auto-start before RDP login), L, M per master prompt. REQ-SEC-001 production note: CLI compose publishes 5432:5432 unbound — production override must fix. RUNS_PER_PROMPT=1 + DEFAULT_DELAY_HOURS=24 go into production env only (CONF-003).

## Key constraints already resolved (do not re-ask)

- User is domain account `MEDIAWORXDE\orlov`, non-elevated; UAC/admin checkpoints expected for Docker Desktop install and ONSTART Scheduled Tasks.
- Docker Desktop NOT installed (only leftover `%LOCALAPPDATA%\Docker\log`); ports 1515/3000/3001/5432 free; WSL Ubuntu-24.04 v2 with systemd running; Node 24.16.0 OK; pnpm absent; corepack 0.35.0; winget 1.29.290; gh absent; git identity unset; GCM configured.
- Conflict register (matrix): CONF-001 placeholder env keys, CONF-002 migrations authorized for dev/test/new-prod DB, CONF-003 RUNS_PER_PROMPT default 5 → env must set 1.
