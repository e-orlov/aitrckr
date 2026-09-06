# F-06 Corrective R2 — Windows `test:scripts` portability and final closeout

Status: **PASS / CLOSED** 2026-09-06. R2 changes exactly one root `package.json` script string and this documentation. **No application code, no image build, no deployment, no container restart, no production configuration or data change.** It resolves the single residual risk left by Corrective R1 and is the authoritative final F-06 closeout reference for F-07 CP0. Raw evidence: operator-private `~/.elmo/f06-corrective-r2-evidence/`.

## Lineage

| Item | Value |
|---|---|
| F-06 application source (image source, unchanged) | `48e697837045c585ffaf32d821dcf601f841ab5d` — [#21](https://github.com/e-orlov/aitrckr/pull/21) |
| F-06 closeout (docs) | `9bc5ba89362078f2ff1535eaa065af72596fc9bd` — [#22](https://github.com/e-orlov/aitrckr/pull/22); tag `production/f06-owned-citation-structure-2026-09-06` (`cb04a570…` → `9bc5ba89…`), release Immutable, unchanged |
| Corrective R1 implementation (operations/test-only) | `39276776fb074e241a249c0e640ac783653c7ffe` — [#23](https://github.com/e-orlov/aitrckr/pull/23) |
| Corrective R1 closeout (docs) | `ef984aa31e9e2e4484fff39ec086326b52367091` — [#24](https://github.com/e-orlov/aitrckr/pull/24); tag `production/f06-owned-citation-structure-closeout-r1-2026-09-06` (`774a4e93…` → `ef984aa3…`), release Immutable, unchanged |
| **Corrective R2 fix (script-only)** | `0bec0e8c34ebc38d92c7873926b2c7e539b8c2c8` — [#25](https://github.com/e-orlov/aitrckr/pull/25); diff = one line of root `package.json` |
| Corrective R2 closeout (docs only) | the commit carrying this file; tagged `production/f06-owned-citation-structure-closeout-r2-2026-09-06` |
| Running production images (unchanged since 2026-09-06T11:12:36Z, restarts 0) | `elmo-web:g48e69783` `sha256:6891e26bc69f44b24978e552e22365384613a96f1d0b61ae55d10275deca766c` (container `62088c8e7ec5`) · `elmo-worker:g48e69783` `sha256:8842d34fe941fb18c0bbf5168d80f77b3635f922eed77390fa3227e02e6c0459` (`11aed739780c`) · `elmo-db-migrate:g48e69783` `sha256:167d86d1c39beb54fa50fe7a7a625a6ee7a2c6235e70b9c091a0a46264c1a07f`; postgres `424a96755bec` started 05:26:57Z |
| Immediate rollback trio (unchanged) | `elmo-web:g4f30f53e` `sha256:2ae5f5cb013f71db44f150e0465a8a7dc9e749ff51af20285ffbbc8733fe9158` · `elmo-worker:g4f30f53e` `sha256:01191f72864d34e10c2dcdd4438f0bd7fa8d17f447f97641271a0b10600c127d` · `elmo-db-migrate:g4f30f53e` `sha256:244e60d21d24aaad7f1501692bc6e136dc21cfa51f86e0415360540a10b0122a` |
| Migration journal | 20 |

## The defect and the fix

Root `package.json` had `"test:scripts": "node --test 'scripts/*.test.mjs'"`. pnpm runs scripts through `cmd.exe` on Windows (`scriptShell` and `shellEmulator` unset, `COMSPEC=cmd.exe`); `cmd.exe` keeps single quotes as literal characters, so Node received the pattern `'scripts/*.test.mjs'`, matched nothing and exited 0 having run **0 tests**. Linux shells strip the quotes, so CI always ran the suite — the Windows gate alone was hollow.

```diff
-    "test:scripts": "node --test 'scripts/*.test.mjs'",
+    "test:scripts": "node --test \"scripts/*.test.mjs\"",
```

Node's test runner expands the glob itself and documents double quotes as the portable spelling. `pnpm-lock.yaml` sha256 `8e5853cc5112baeb3cf53a79156c520cb41219ac0e35bb70ce24e64d3b90160b` before and after (no install run). No test file changed.

## Test-gate reconciliation

| Environment | Baseline canonical (`ef984aa3`) | Candidate canonical (`0bec0e8c`) | Direct control `node --test "scripts/*.test.mjs"` | Result |
|---|---:|---:|---:|---|
| Windows 10 VM, pnpm 11.18.0, node 24.16.0 — `pnpm test:scripts` from Git Bash | tests 0 / pass 0 / fail 0 / cancelled 0 / skipped 0 / todo 0 (rc 0) | **tests 30 / pass 30 / fail 0 / cancelled 0 / skipped 0 / todo 0** | 30 / 30 / 0 / 0 / 0 / 0 | PASS |
| Windows — `cmd.exe /c pnpm test:scripts` | tests 0 (echoed `node --test 'scripts/*.test.mjs'`) | **tests 30 / pass 30 / fail 0** (echoed `node --test "scripts/*.test.mjs"`) | same | PASS |
| Linux CI (Build workflow step "Release script tests") | 30 / 30 / 0 (quotes stripped by sh) | **30 / 30 / 0 / 0 / 0 / 0** on PR #25 and on post-merge main `0bec0e8c` | — | PASS |

Discovered files in every run: `scripts/check-server-bundle.test.mjs` (10), `scripts/discord-release-payload.test.mjs` (4), `scripts/gen-prod-env.test.mjs` (16) = 30. Named negative/refusal cases pass in the canonical Windows run: forbidden `pg` / `drizzle-orm/node-postgres` require detection (native and POSIX app-dir spellings), forward-slash reporting of nested bundle files, "fails a require of a package the bundle does not ship", vercel preset detection, "no server bundle" failure, CFG-01…CFG-15, "refuses an empty, root or home target directory".

## Full verification

Local (Windows): lint 702 files / 0 · check-types 13/13 · unit lib 633, web 433, config 93, cloud 43, cli 28 · **`pnpm test:scripts` 30/30** · Storybook 123/123 · `pnpm build` 16/16, clean tree · license check 1,260 compliant · Playwright `local` 89 passed / 2 established worker-gated skips · `check-server-bundle.mjs apps/web` rc 0 · client assets free of database code. No exception of any kind remains.
CI: PR #25 required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit success; post-merge `main` workflows at `0bec0e8c` success.

## Read-only production continuity (2026-09-06T14:28Z, after the merge)

Trio, container ids, start times and restart counts identical to CP0 (above); HTTP 200; journal 20; citations 931, enabled prompts 33, runs 318, scheduler 33 single pending chains; arag prompts digest `fc19ab03…` and citations digest `d3e5dbf9…` identical before and after the check; live `.env`/`elmo.yaml` sha256[:16] `5155578153d44336` / `1690d903f0f175c3` identical to CP0 (contents never read); Citations and Citation Structure load through the sidebar, 81 owned occurrences = root = every depth, 0 console/page errors, 0 failed same-origin requests; worker log 0 errors; web log only the acceptance browser's own `Error: aborted` pair at 14:28:34Z. Authentication side effect as documented in R1: one `session` row created for the headless browser and deleted, count 1 → 1. Business-data writes 0. No config regenerated, no Docker action, no provider call.

## R1 residual risk — resolved

R1 recorded: "`pnpm test:scripts` runs 0 tests on Windows … follow-up: switch to double quotes in a separate small PR." Resolved by `0bec0e8c` (PR #25) with the Windows and Linux evidence above. The R1 addendum keeps its historical wording and now points here.

## Scope proof

```
root package.json script strings changed: 1
other package manifest fields changed: 0
dependencies changed: 0
pnpm-lock.yaml changed: 0
test files changed: 0
application runtime files changed: 0
Citation Structure behavior changes: 0
migrations/schema changes: 0
Docker images built: 0
Docker images deployed: 0
containers restarted/recreated: 0
production config files rewritten: 0
production business-data writes: 0
provider/LLM/browser-scrape/external-fetch calls: 0
```

## F-07 handoff contract

```
F07_PLANNING_BASELINE_SHA=33c94cd175f9b128cfd03901ff04ab51fc189f45
F07_START_MAIN_REF=refs/tags/production/f06-owned-citation-structure-closeout-r2-2026-09-06
F07_START_MAIN_SHA=resolve the peeled commit from F07_START_MAIN_REF during F-07 CP0 and compare it with origin/main
F07_START_PROD_APP_SOURCE_SHA=48e697837045c585ffaf32d821dcf601f841ab5d
F07_START_PROD_WEB_IMAGE=elmo-web:g48e69783@sha256:6891e26bc69f44b24978e552e22365384613a96f1d0b61ae55d10275deca766c
F07_START_PROD_WORKER_IMAGE=elmo-worker:g48e69783@sha256:8842d34fe941fb18c0bbf5168d80f77b3635f922eed77390fa3227e02e6c0459
F07_START_PROD_DB_MIGRATE_IMAGE=elmo-db-migrate:g48e69783@sha256:167d86d1c39beb54fa50fe7a7a625a6ee7a2c6235e70b9c091a0a46264c1a07f
F07_ROLLBACK_WEB_IMAGE=elmo-web:g4f30f53e@sha256:2ae5f5cb013f71db44f150e0465a8a7dc9e749ff51af20285ffbbc8733fe9158
F07_ROLLBACK_WORKER_IMAGE=elmo-worker:g4f30f53e@sha256:01191f72864d34e10c2dcdd4438f0bd7fa8d17f447f97641271a0b10600c127d
F07_ROLLBACK_DB_MIGRATE_IMAGE=elmo-db-migrate:g4f30f53e@sha256:244e60d21d24aaad7f1501692bc6e136dc21cfa51f86e0415360540a10b0122a
F07_START_MIGRATION_JOURNAL_COUNT=20
```

Commits after the application source: `9bc5ba89` docs-only (#22) · `39276776` operations/test-only (#23) · `ef984aa3` docs-only (#24) · `0bec0e8c` script-only (#25) · this commit, docs-only. None is an image source.
