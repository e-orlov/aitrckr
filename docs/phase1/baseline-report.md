# Phase 1 — stage D baseline report (fork @ b3bea1e, branch phase1-local-production-setup)

Environment: Windows 10 Pro 22H2, Node 24.16.0, pnpm 11.18.0 (corepack), Docker Desktop 4.88.1 / engine 29.7.2, dev PostgreSQL container `aitrckr-dev-postgres` (postgres:18-alpine, 127.0.0.1:5432, volume `aitrckr-dev-pgdata` mounted at `/var/lib/postgresql`).

## Baseline commands (CT-QUAL-*)

| Step | Command | UTC | Duration | Exit | Result |
|---|---|---|---|---|---|
| Dependency install | `pnpm install --frozen-lockfile` | 2026-08-29T~10:15Z | 2m57s | 0 | PASS — lockfile respected, supply-chain controls untouched, postinstall only fumadocs-mdx (allowlisted) |
| Migrations (dev DB) | `pnpm exec drizzle-kit migrate` (packages/lib, DATABASE_URL=elmo_dev) | 2026-08-29T~10:30Z | <1m | 0 | PASS — authorized by CONF-002; 19 tables in public schema |
| Lint (1st) | `pnpm lint` | 2026-08-29T10:35:42Z | 2.2s | 1 | FAIL → DEF-002 (environment, not fork defect) |
| Lint (confirmation) | `pnpm lint` | 2026-08-29T10:39:29Z | 9.0s | 0 | PASS — 606 files, 0 errors |
| Unit tests | `pnpm test` | 2026-08-29T10:39:46Z | 1m23s | 0 | PASS — 13 turbo tasks; @workspace/web 16 files / 282 tests, @workspace/lib 32 files / 486 tests, all green; no provider keys needed |
| Build | `pnpm build` | 2026-08-29T10:41:23Z | 1m9s | 0 | PASS — 16 turbo tasks (8 cached), web nitro output built in 15.7s |
| Playwright browsers | `pnpm exec playwright install` | 2026-08-29T10:47Z | ~2m | 0 | PASS |
| E2E + Bruno API | per `.github/workflows/e2e.yaml` (single source of truth: `elmo init --dev` → compose build → seed → playwright per mode) | — | — | — | PLANNED at stage E — requires the Dockerized test stack on :1515 |

## Defect register (stage C–D)

### DEF-001 — Docker Desktop crash on stop→start (stale secrets-engine socket)

- Symptom: on the first `docker desktop stop` → `start` cycle, Desktop crashed: `starting services: initializing Secrets Engine: listening on unix://…/docker-secrets-engine/engine.sock: remove …engine.sock: cannot access the file`.
- Root cause: stale AF_UNIX socket file left by the previous instance; orphaned socket files on Windows are undeletable until reboot; new instance could not remove it.
- Fix: killed leftover `docker`/`docker-desktop` CLI processes, renamed `%LOCALAPPDATA%\docker-secrets-engine` aside (stale copy `docker-secrets-engine-stale` — delete after next reboot), relaunched Desktop (engine up in ~10s).
- Confirmation: relaunch succeeded, fresh socket created. Regression: hello-world pull/run/rmi PASS; settings persisted.
- Classification: environment/vendor issue, not a fork defect. Watch during stage J/K restart tests; the startup/watchdog scripts must tolerate or clean stale socket state.

### DEF-002 — Biome reports 606 errors: CRLF working tree

- Symptom: first `pnpm lint` failed with format errors in all 606 files (`␍` at line ends).
- Root cause: repo cloned with global `core.autocrlf=true` (Git for Windows default) → working tree checked out CRLF; Biome/upstream require LF. Environment/config issue, not a fork defect.
- Fix: repo-local `core.autocrlf=false`; working tree rewritten from the (LF) index: `git ls-files -z | xargs -0 rm -f && git checkout-index -a -f`, then `git add -u` to refresh stat cache. Verified: `git ls-files --eol` → 929 `w/lf`, 0 `w/crlf`; `git status` clean; staged diff empty (no content change).
- Confirmation: `pnpm lint` PASS (0 errors). Note for runbook: on Windows clones of this repo set `core.autocrlf=false` (or `input`) before checkout.
