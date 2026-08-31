# Phase 1 — resilience report (stage J, production-like stack)

Stack: disposable `aitrckr-prodlike` (config `%USERPROFILE%\.elmo-prodlike`, prod overrides: restart unless-stopped, web 127.0.0.1:1515, log rotation; prodlike extras: stub provider, pg on 127.0.0.1:5434 for the seeder). Fixtures: e2e seed + synthetic prompts. No paid calls. Dates: 2026-08-31.

## Key Docker behavior facts established empirically

1. `docker stop` / `docker kill` are **manual stops**: `restart: unless-stopped` does NOT revive the container (observed: both web and worker stayed `Exited (137)`). Only in-container process death or engine restart triggers the policy. Crash tests therefore use in-container signals.
2. PostgreSQL PID 1 + SIGTERM = *smart shutdown*: with open web/worker connections it hangs indefinitely; container shows `Up (unhealthy)` and **nothing auto-restarts an unhealthy-but-running container**. Watchdog requirement (stage K): treat prolonged `unhealthy` as failure and restart the service.
3. DEF-001 (stale `docker-secrets-engine\engine.sock` crash on Docker Desktop stop→start) is **systematic on this VM: 2/2 restarts reproduced it**. Recovery (kill leftover docker processes → rename socket dir → relaunch Desktop) works reliably; engine back in seconds. The stage K startup/watchdog scripts MUST run this cleanup before/when starting Docker Desktop.

## Test log

| ID | Scenario | Method | Result |
|---|---|---|---|
| J1 | web crash | `docker exec web kill 1` | **PASS** — container auto-restarted (restart policy), UI serving again (HTTP 307 root redirect) |
| J2 | worker crash | `docker exec worker kill 1` | **PASS** — auto-restarted (Up 22s after crash) |
| J12 | job submitted while worker down | POST /api/v1/prompts during crash window | **PASS** — durable pg-boss job processed after worker returned; exactly **1 run** recorded — production `RUNS_PER_PROMPT=1` honored (direct REQ-AI-003 evidence on a new schedule) |
| J11 | restart after completed evaluation | count runs → `docker restart worker` → recount | **PASS** — 1 before / 1 after; no duplicate completed evaluation |
| J3 | postgres crash | `docker exec postgres kill -QUIT 1` (immediate shutdown) | **PASS** — container auto-restarted, healthy in ~15s, WAL recovery clean, 17 prompt_runs intact, web serving. Bonus finding: TERM (smart shutdown) hangs with open connections — see fact 2 |
| J9 | idempotent recovery | second `docker compose up -d` | **PASS** — same 3 running containers + completed migrate; no second stack, no recreation |
| J4 | Docker engine/Desktop restart | `docker desktop restart` | **PASS with caveat** — Desktop crashed on DEF-001 (expected); after scripted recovery the engine was back in ~5s and **all prodlike containers auto-started** (policy fired at engine start), data intact. Side note: containers without a restart policy (generated test compose) stay down — test env needs manual start after engine restarts (runbook note) |
| J10 | provider 429 behavior | analysis (no live 429 injectable via stub) | **DOCUMENTED** — current behavior: process-prompt queue retries (retryLimit 3, backoff) at queue level; worker self-re-enqueue uses retryLimit 0 with run-policy `failureBackoffHours` (verified by `run-backoff.test.ts`, `scheduling-under-failure.test.ts`, 486 green unit tests). DEF-003 (402) showed a failed cycle reschedules with 0.25h backoff. Phase 2 backlog item three (429 retry/backoff hardening) NOT implemented per scope |
| J7 | worker crash during synthetic job | covered by J2/J12 (stub jobs are sub-second; crash window covered by submit-while-down) | **PASS** (as J12) |
| J5 | Docker Desktop stopped → watchdog revives | stage K (watchdog script) | PLANNED |
| J6 | RDP disconnect / logoff | stage K (needs user) | PLANNED |
| J8 | Windows reboot during batch | stage K cold-boot test | PLANNED |

## pg-boss configuration audit (REQ-JOBS-001)

From code at b3bea1e (details in feature inventory): schema `pgboss`, maintenance every 30s; `process-prompt` queue retryLimit 3/retryDelay 60/backoff/expire 900s, worker self-re-enqueue retryLimit 0 + expire 5400s (run policy owns retry timing via failureBackoffHours); singletonKey `prompt-<id>` + singletonSeconds = cadence → duplicate firings are no-ops (verified upstream by worker.spec volume contract and scheduling verifier; observed here via J11/J12). `generate-report` retryLimit 3/expire 3600; `analyze-brand` retryLimit 1. Graceful shutdown: SIGTERM → boss.stop(graceful, 30s) with compose stop_grace_period 35s.

**Exactly-once is NOT promised**: an in-flight HTTP call to a provider at crash time cannot be resumed; pg-boss retries the job, so a rare duplicate provider call/cost is theoretically possible (master prompt acknowledges this). Completed evaluations are not re-recorded (J11).

## Requirement status updates

- REQ-RES-001 (kill/restart web/worker/postgres/Docker) → **PASS** (J1–J4).
- REQ-DATA-002 → container/engine restarts **verified**; Windows reboot pending stage K.
- REQ-DATA-001 (named volume persistence) → **PASS** on prodlike volume across postgres crash + engine restart; re-verify on the real prod volume at stage L.
- REQ-JOBS-001 → **PASS** (audit + J11/J12).
- REQ-OPS-001/002/003 → stage K.
