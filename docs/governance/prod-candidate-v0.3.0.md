# Production candidate v0.3.0 — build & prodlike acceptance record

Phase inputs: main = `a8747c20c94c9f0acfeaa60f8ad756af4444b1d8` (upstream v0.3.0 merged); production runs untouched on `g34057521` (volume `elmo_postgres_data`, config `%USERPROFILE%\.elmo`) for the whole phase. Deployment is NOT part of this phase.

Preflight 2026-09-01: main==origin clean; CI 4/4 success on a8747c20; production HEALTHY (HTTP 200, containers Up, StartedAt 2026-08-31T19:39:11Z); RAM 7.1/15.6 GB free; disk C: 15.4 GB free (sufficient for ≤3–4 GB phase footprint; **watch item**, no prune performed).

## Requirements

| ID | Requirement | Result | Status |
|---|---|---|---|
| REQ-RC-001 | Candidate images reproducible from the exact accepted app commit, RC-tagged, no `latest` | images `elmo-{web,worker,db-migrate}:rc1-a8747c20` built from working tree with 0 non-docs delta vs `a8747c20`; IDs `0c6451df…` / `8d51e8da…` / `368b6f59…`; no `latest` tag written | PASS |
| REQ-RC-002 | Production fully isolated | project `aitrckr-rc030`, config `%USERPROFILE%\.elmo-rc030` (fresh generated keys, provider key = PLACEHOLDER — production key never copied), web `127.0.0.1:1516`, RC postgres publishes no host port (`docker port` = none), own volume; prod config/tasks untouched; read-only prod snapshots before/after identical | PASS |
| REQ-RC-003 | Migrations 0016/0017 succeed on restored prod copy via stock db-migrate; idempotent re-run | dump 277,559 B restored; RC db-migrate exit 0; re-run exit 0 (no-op) | PASS |
| REQ-RC-004 | Data integrity across migration | all control counts identical pre/post: brands 1, org 1, user 1, prompts 27/27 enabled, runs 27, citations 84, usage 27, competitors 12, pgboss created 27, next_run 2026-09-02T06:36Z; `slug` NULL with id-fallback; old citations index dropped, new covering index present | PASS |
| REQ-RC-005 | Feature regression on candidate images | on literal rc1 images with fresh-migrated seeded DB: Playwright local **80 passed / 0 failed / 0 flaky / 2 skipped**, Bruno exit 0, worker E2E 1/1; on the real-data RC stack: unauth `/app` → login redirect, login page 200, stub scheduler cycle exactly **1 run per prompt** (RUNS_PER_PROMPT=1), 0 worker errors | PASS |
| REQ-RC-006 | Resilience | restart web+worker+postgres → web 200; repeat `compose up` = no recreation; prompt_runs 54/54 preserved | PASS |
| REQ-RC-007 | Rollback compatibility | **forward-compatible rollback confirmed (preferred plan)**: `g34057521` web served 200 (incl. /auth/login) and `g34057521` worker booted and successfully WROTE (27 stub runs) against the migrated schema with 0 errors; 0016/0017 reversal rehearsed ONLY on the extra disposable copy `elmo_rev` (structure restored, counts 1/27/27/84 intact, drizzle journal −2); production DB never touched | PASS |
| REQ-RC-008 | Security/config parity | 1516 loopback-only (netstat); RC pg unpublished; worker stub-only; json-file logs max-size 10m × 3; 0 secret patterns in logs | PASS |

## Gates

| Gate | Meaning | Status |
|---|---|---|
| GATE-RC-1 | Preflight + plan | **PASS** 2026-09-01 |
| GATE-RC-2 | Candidate images built + isolated stack on restored prod copy, migrations proven | **PASS** 2026-09-01 |
| GATE-RC-3 | Acceptance + resilience + rollback rehearsal green | **PASS** 2026-09-01 |
| GATE-RC-4 | PR checks green; user merge approval (deploy still NOT authorized) | **PASS** — PR #6 squash-merged with user approval; main SHA 9b49c56c04882d1024634fb466114c833bf440e3; push-to-main CI 4/4 workflows / 5/5 checks success on that SHA with only [notice] Playwright annotations (0 flaky/failure; local 80 passed / 2 skipped); production untouched on g34057521 (snapshot: same StartedAt 2026-08-31T19:39:11Z, HTTP 200, HEALTHY) |

## Candidate manifest

| Item | Value |
|---|---|
| Source commit (app) | `a8747c20c94c9f0acfeaa60f8ad756af4444b1d8` (branch adds docs-only commits; Docker context identical) |
| elmo-web:rc1-a8747c20 | `sha256:0c6451dfb7e4b32c2cad91651d741e0f999efde8aec055c104e38cfb8c36f8ab` |
| elmo-worker:rc1-a8747c20 | `sha256:8d51e8da67dc7dd2c7baf0bcb4b0958d1d2ad81543ef777a3deb9a5c1e590c3c` |
| elmo-db-migrate:rc1-a8747c20 | `sha256:368b6f593a62c68b588d0bdf8fb1241c0968fbfa1baba7dee6290631ca742969` |
| RC stack | project `aitrckr-rc030`, config `%USERPROFILE%\.elmo-rc030`, web `127.0.0.1:1516`, volume `aitrckr-rc030_postgres_data`, worker `stub:stub` via `docs/governance/rc030/rc-extras.override.yaml` |
| Prod-copy dump | `%USERPROFILE%\.elmo-rc030\dump\prod-copy.dump` (277,559 B) + `prod-control-counts.txt` (outside Git) |

Amendment rule: any application-code change in this phase invalidates rc1 — build rc2 and repeat the affected tests.

## Notes / artifacts of the copy environment (not defects)

- Stub-target first run: with the worker pinned to `stub:stub`, the run policy correctly treats the never-run stub target as due and executes one run per prompt (observed on both old and RC workers against the copy; $0, no network). On the real cutover the production worker keeps its chatgpt target — no such extra cycle occurs.
- pg-boss singleton throttle suppressed re-enqueue after two same-day cycles on the copy (restored 06:36Z cycle + stub cycle): the worker logged rescheduling, the sends were deduped within the cadence slot. Chain revival for overdue prompts is maintenance-owned and already proven (Phase 1 J12/DEF-003 evidence + scheduling-policy CI). Not a v0.3.0 regression; irrelevant to the production cutover (one cycle per slot there).

Deployment plan (commands, checkpoints, rollback): `docs/governance/rc030/deployment-plan.md`. Production deploy, prod-DB migration and the switch off `g34057521` require a further explicit user authorization.
