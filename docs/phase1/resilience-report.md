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
| J5 | Docker Desktop stopped → watchdog revives | `docker desktop stop` 2026-08-31T14:16:57Z (engine confirmed down 14:17:12Z), no manual recovery | **PASS** — scheduled watchdog tick detected engine down 14:17:31Z, ran DEF-001 cleanup, engine ready 14:17:40Z, compose up restored all 3 services (~48s stop→recovered); web HTTP 307, prompt_runs 17, exactly one compose project. Next tick (14:22:22Z) was a no-op: container uptime continuous, no log entries, task result 0x0 — idempotent, no second stack |
| J6 | RDP disconnect / logoff | disconnect: event-log IDs 24/25 + 30s health monitor; logoff: in-container monitor + docker events | **PASS** — disconnect: RDP disconnected 2026-08-31T14:41:41Z → reconnected 15:18:32Z (36.9 min, TerminalServices-LocalSessionManager events 24/25); host monitor 30s probes over 14:26:48–15:30:08Z: 87/87 `web:307 pg:healthy` (`logs\rdp-disconnect-monitor.log`). Logoff: sign-out 15:36:49Z → logon 16:03:36Z (26.8 min, events 23/21); in-container monitor (survives logoff) 66/66 `web:307` continuously 15:31:56–16:04:26Z spanning the whole window (`logs\logoff-monitor.log`); container StartedAt unchanged (14:17:39Z) — no restarts; web serving after logon |
| J8 | Windows reboot / queue durability | cold boot 2026-08-31 (see Stage K section) + decomposition | **PASS with note** — reboot persistence proven (prompt_runs 17 → 17, schedules intact); an in-flight batch at the reboot instant was not separately reproducible: stub jobs complete sub-second, and job-crash durability is already proven by J12 (submit while worker down) + J3 (WAL recovery). In-flight provider HTTP at crash time remains not-resumable (documented limitation) |

## pg-boss configuration audit (REQ-JOBS-001)

From code at b3bea1e (details in feature inventory): schema `pgboss`, maintenance every 30s; `process-prompt` queue retryLimit 3/retryDelay 60/backoff/expire 900s, worker self-re-enqueue retryLimit 0 + expire 5400s (run policy owns retry timing via failureBackoffHours); singletonKey `prompt-<id>` + singletonSeconds = cadence → duplicate firings are no-ops (verified upstream by worker.spec volume contract and scheduling verifier; observed here via J11/J12). `generate-report` retryLimit 3/expire 3600; `analyze-brand` retryLimit 1. Graceful shutdown: SIGTERM → boss.stop(graceful, 30s) with compose stop_grace_period 35s.

**Exactly-once is NOT promised**: an in-flight HTTP call to a provider at crash time cannot be resumed; pg-boss retries the job, so a rare duplicate provider call/cost is theoretically possible (master prompt acknowledges this). Completed evaluations are not re-recorded (J11).

## Stage K — cold boot acceptance test (OT-OPS-002, 2026-08-31)

Setup: Scheduled Tasks (S4U principal `<DOMAIN\user>`, session 0, no stored password): `aitrckr-elmo-startup` ONSTART+2min, `aitrckr-elmo-watchdog` every 5 min, `aitrckr-elmo-logon-marker` at logon. Markers cleared pre-reboot; user confirmed reboot and stayed off RDP for ~30 min.

Timeline (UTC, from `%USERPROFILE%\.elmo-prodlike\logs\elmo-ops.log`, markers, and task LastRunTime):

| Event | UTC | Source |
|---|---|---|
| Windows boot | 13:37:39Z | `LastBootUpTime` |
| startup task fired | 13:39:39Z | task LastRunTime (0x0) |
| orchestrator begin, DEF-001 cleanup, Docker Desktop start | 13:39:54–55Z | elmo-ops.log |
| Docker engine ready | 13:40:17Z | elmo-ops.log |
| stack healthy (web HTTP 307), startup-health.marker written | 13:40:42Z | elmo-ops.log + marker content |
| first interactive logon | 14:10:02Z | first-logon.marker (logon-marker task, 0x0) |

Result: **PASS** — production-like stack healthy 3:03 after boot and **29.3 min before the first logon**, with zero manual action. Post-logon assertions: `docker ps` shows exactly one prodlike project Up since boot (web 127.0.0.1:1515→3000, postgres healthy on 127.0.0.1:5434); `prompt_runs` count 17 (unchanged across reboot); web probe HTTP 307; watchdog task running on schedule, LastTaskResult 0x0. DEF-001 cleanup executed automatically by the orchestrator as designed. Note: startup-health.marker had been re-written by a pre-reboot rehearsal at 13:34:23Z, but the surviving content (13:40:42Z) postdates boot, so the marker unambiguously proves post-boot health.

## Stage L — production reboot validation (AT-DATA-001, 2026-08-31)

Repeat of the cold-boot test on the REAL production stack (project `elmo`, real account/brand/27 prompts, images g34057521), after the first paid cycle completed (27 runs / 84 citations). Reboot initiated 19:35:16Z after user checkpoint; user stayed off RDP ~17 min.

Boot 19:36:35Z → startup task → orchestrator 19:38:50Z (DEF-001 cleanup ran) → engine ready 19:39:12Z → **stack healthy 19:39:37Z (3:02 after boot, web HTTP 200)** → first logon 19:56:26Z (16.8 min later). Post-logon: containers Up since boot with pinned images; DB counts identical to pre-reboot snapshot (27 prompt_runs / 84 citations / 27 enabled prompts / 27 queued next-cycle jobs, start_after ≈ 2026-09-01T18:36Z); user opened the dashboard and confirmed saved data and schedules (REQ-DATA-003 **PASS**). This also re-proves REQ-OPS-002 mechanics on the production project itself.

## Requirement status updates

- REQ-RES-001 (kill/restart web/worker/postgres/Docker) → **PASS** (J1–J4).
- REQ-DATA-002 → **PASS** — container/engine restarts (J1–J4) + Windows reboot (Stage K cold boot: 17 prompt_runs before/after).
- REQ-DATA-001 (named volume persistence) → **PASS** on prodlike volume across postgres crash + engine restart + reboot; re-verify on the real prod volume at stage L.
- REQ-JOBS-001 → **PASS** (audit + J11/J12).
- REQ-OPS-002 → **PASS** (Stage K cold boot section above).
- REQ-OPS-003 → **PASS** (J5: unattended engine+stack recovery in ~48s, idempotent, single stack).
- REQ-OPS-001 → **PASS** (J6: disconnect 36.9 min + logoff 26.8 min, production uninterrupted, machine-verified by continuous probes and unchanged container StartedAt).
