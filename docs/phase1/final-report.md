# Phase 1 — final handoff report

Date: 2026-08-31. Verdict: **PRODUCTION READY** (all 9 gates PASS, 42/42 requirements PASS; PR: https://github.com/e-orlov/aitrckr/pull/1).

## What is running

- **Production URL**: http://localhost:1515 (loopback only; `127.0.0.1` is rejected by auth origin check — always use `localhost`).
- **Backend**: Docker Desktop 4.88.1 (WSL2, per-user), Compose project `elmo`: web + worker + PostgreSQL 18 + migrate step.
- **Deployed commit/images**: fork `34057521` → `elmo-web:g34057521`, `elmo-worker:g34057521`, `elmo-db-migrate:g34057521` (no `latest`); postgres pinned by digest in production-manifest.md.
- **Data**: real account, 1 brand, 11 competitors, 27 prompts (all enabled by user decision), first paid cycle complete — 27 runs, 84 citations, ~$0.135 total; next cycle daily ≈ $0.32/day at current prices.
- **Auto-start**: Scheduled Tasks (S4U, no stored password) start Docker Desktop + stack at Windows boot before any logon; watchdog every 5 min recovers engine (incl. DEF-001 cleanup) and unhealthy services.

## Gates

L1 PASS, L2 PASS, S1 PASS, B1 PASS, R1 PASS, R2 PASS, R3 PASS, R4 PASS, R5 PASS — details and evidence in gate-record.md.

## Requirements traceability

42 requirements in the canonical matrix (requirements-matrix.md): **42/42 PASS** (final audit after PR creation: https://github.com/e-orlov/aitrckr/pull/1). 0 FAIL, 0 BLOCKED. Excluded capabilities are marked NOT CONFIGURED BY DESIGN inside the feature-test matrix, never on mandatory requirements. No orphan requirements, tests, or changes (bidirectional audit at GATE-R5).

## Test evidence (all on this VM)

- Unit/build/lint: 811 unit tests green (fresh, cache-bypassed) + lint 0 errors + full build on final HEAD.
- E2E/API (GATE-R3, same app code): 63/63 local Playwright, Bruno 54 requests / 116 assertions, worker volume-contract E2E.
- Skills qualification: CT/IT/ST-SKILL suites PASS (agent-skills @ `d2c37ef`, 3 project skills, MIT, hashes locked).
- Resilience (stage J): web/worker/postgres crash, engine restart, idempotent recovery, no duplicate completed evaluations, queue durability across worker death.
- Operational (stage K/L): cold boot prodlike — healthy 3:03 after boot, 29.3 min before first logon; watchdog recovery in ~48s, idempotent; RDP disconnect 36.9 min + logoff 26.8 min with 100% healthy probes; production reboot — healthy 3:02 after boot, 16.8 min before logon, all data intact, user confirmed dashboard.

## Where things are

- Runbook: docs/phase1/runbook.md (dev/test/prod commands, recovery, update).
- Deploy/rollback: docs/phase1/production-manifest.md.
- Matrices: requirements-matrix.md, feature-test-matrix.md; gates: gate-record.md.
- Ops scripts: docs/phase1/ops/ (start/stop/health/watchdog/install-tasks/remove-tasks).
- Reports: baseline, prerequisite, resource, resilience, skills qualification — same folder.
- Git: branch `phase1-local-production-setup` in `e-orlov/aitrckr`; PR into fork `main` (URL in PR itself; no direct main push, no merge performed).

## What the user does next

1. Watch the daily cycle for a few days; spend visible at https://openrouter.ai/activity and in the in-app usage events (~$0.005/run observed).
2. Adjust prompts/competitors in Settings; keep total ≤ 100 prompts (upstream cap).
3. New code versions: test stack → build → explicit deploy per production-manifest.md. No auto-updates exist.
4. Merge or keep the PR open at your discretion (do not merge automatically).

## Known limitations

- Measurements use the OpenRouter model API (`openai/gpt-5.6-luna` + web search) as a proxy — **real consumer ChatGPT (chatgpt.com) scraping is neither configured nor claimed as tested** (scraper-dependent features are NOT CONFIGURED BY DESIGN).
- An in-flight HTTP call to the provider cannot be resumed after a crash/reboot; pg-boss retries the job, so a rare duplicate provider call/cost is theoretically possible — **exactly-once is not promised**. Completed evaluations are never re-recorded (proven).
- Query fan-out data is provider-dependent; OpenRouter `:online` currently returns citations but no stored web queries (documented at GATE-R3).
- Windows 10 + nested Hyper-V is at the edge of Docker Desktop vendor support; acceptance is based on actual on-VM tests (recorded as a warning, not a defect).
- `:online` suffix is deprecated upstream in favor of the web plugin/server tool — functional today; revisit on the next dependency refresh.
- Disk C: at ~75%; Docker build cache ~11 GB reclaimable via `docker builder prune` (manual, user decision).
