# SENT-R0 Competitor identity preservation — production closeout

Status: **PRODUCTION REAL-LIFE ACCEPTANCE PASS / CLOSED** 2026-09-12. First deliverable of SENT-01 (Brand & Competitor Sentiment); the sentiment foundation and page (SENT-R1/R2) follow in a separate PR and are **not** part of this release. Raw evidence (SQL snapshots, screenshots, logs, driver output): operator-private `~/.elmo-task-evidence/sent-01/` (`cp0-baseline.md`, `r0-merge-packet*.md`, `build/`, `rehearsal/`, `r0-deploy-packet*.md`, `cutover/`, `live-acceptance/`). Task registry `~/.elmo-task-registry/aitrckr/SENT-01.json`.

## What changed

Saving competitor settings used to delete every competitor row of the brand and reinsert the submitted list, minting new UUIDs on every save (proven on the unmodified code: a no-op save preserved 0 of 2 ids). Now:

- `competitors` gains `active boolean not null default true`, `removed_at timestamptz null`, `previous_names text[] not null default '{}'` and the index `competitors_brand_id_active_idx (brand_id, active)` — migration `0020_competitor_lifecycle`, additive; existing rows keep their ids and are active.
- The settings save is an in-place diff (`packages/lib/src/db/competitors.ts` planner, `apps/web/src/server/competitor-roster.ts` transaction with `FOR UPDATE`): entries with an `id` update in place; omitted active rows become inactive with `removed_at`; new entries insert once; an id-less entry reuses exactly one stored row that shares a normalized domain (never by name alone); ambiguous matches, duplicate domains and ids the brand does not own reject the whole save. Renames append the old name to `previous_names`. The editor now carries the database id per entry.
- Public API `DELETE /api/v1/competitors/{id}` is a soft removal; list/GET/PATCH address active competitors only.
- Every "currently tracked" reader filters `active` (brand hydration and layout loader, settings roster, Visibility / Competitive Visibility rosters, Citations, Overview, prompt stats and charts, Opportunities, onboarding dedupe, prompt snapshot API, competitor cap, worker mention detection, source-classification backfill context). Semantics table: `docs/governance/sent-01-brand-competitor-sentiment/requirements-test-matrix.md`.

Nothing in the product physically deletes a competitor any more. No dependency, provider, model, scheduling or configuration change.

## Identities

| Item | Value |
|---|---|
| Starting baseline | `25abb65d511fb53894164c0cd07e312076913e3c` (UI-R1 closeout; production `g039026ac`) — CP0 2026-09-11T19:44Z, no drift; LOC-01 (#36) merged and deployed in parallel and was absorbed by a normal merge |
| Branch / worktree | `feat/sent-01-r0-competitor-identity` in `../aitrckr-sent01-r0` (11 commits + 2 merges of `main`) |
| Feature PR | [#37](https://github.com/e-orlov/aitrckr/pull/37) — Build / Dependency License Audit / E2E Integration Tests / Scheduling Policy Verification / smoke 5/5 on `bc28a326` and again on `f8ea72e6`; squash-merged 2026-09-11T22:04:47Z after a six-condition pre-merge check |
| Application source | `1d67e4fd5b629944fb63a2532de43ae13f8343f1` — post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check 4/4 success |
| Files changed | 31: schema + `0020_competitor_lifecycle.sql` + snapshot + journal; `packages/lib/src/db/competitors.ts` (+16 unit tests) and lib export; `apps/web/src/server/competitor-roster.ts`, `brands.ts`, editor, settings route, public competitor API, 9 active-roster readers, `prompts-display.tsx` stub fields; worker roster + backfill predicate; `e2e/tests/local/competitor-identity.spec.ts`; `competitor-identity.integration.test.ts`; `openapi.json`; changeset; matrix doc |
| Images (built once 2026-09-11T22:05:57–22:29:30Z from the clean detached worktree `../aitrckr-sent01-build` at the source commit, isolated config dir `%USERPROFILE%\.elmo-sent-01-build`, project `elmo-sent-01-build`; no `latest`) | `elmo-web:g1d67e4fd` `sha256:2efd71b26f7b9775b536b56fc6e809b4de364291f2c821899772a86119ea57a6`; `elmo-worker:g1d67e4fd` `sha256:6da0950e298b51850d091aaa557309a7e1ecf06cc04347504a403084b5793422`; `elmo-db-migrate:g1d67e4fd` `sha256:a6bc58f02ba2ab42e3971a0ae948e8c58c11f429b982d760334f688b870f090d`; never rebuilt; the same ids ran in rehearsal, rollback → return, and production |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, container not recreated by the cutover |
| Migration journal | **20 → 21** (`0020_competitor_lifecycle`, hash `dc1d9f28cc7b…`); applied in rehearsal (restored copy) and production with exit 0; competitor id/business digest `3daf1f077579b3c6d9e3aab0d90cea66` identical before and after both |
| Rollback target | `g94705764` trio (web `8df979f40983`, worker `a54936a4fd91`, db-migrate `ea26f6858dc2`), on disk; image-only, rehearsed on the migrated copy (old journal 20 leaves the DB at 21; old UI reads the roster). **While a pre-R0 image is live after 0020, competitor settings must not be edited** — the old code still bulk-deletes on save |
| Backups | rehearsal `elmo-prod-pre-sent-r0-rehearsal-20260911-220631.dump` 2,921,970 B sha256 `e8c6c3b1a1750daf5f8789d4aacdb68dc2f34265e63a15d69081039385cbe5c2` (restored identically: 502 runs / 1,457 citations / 12 competitors / journal 20); JIT pre-cutover `elmo-prod-pre-sent-r0-cutover-20260912-145548.dump` 3,223,098 B sha256 `140cdc3a17209f1be1a768d5895ab1006738fc3d8cc71716b3ec5a96fad9ba7e` (restore-verified: 562 runs / 1,626 citations / 12 competitors / 33 prompts / 1 session / journal 20 / digest `3daf1f07…`) |
| Quiet window | the 08:57–14:57Z natural cycle (12 h brand override) was left untouched and polled read-only every 10 min; at 14:55Z active 0 / retry 0 / 33 chain jobs all ≥ 20:57:31Z |
| Pre-cutover revalidation (14:55Z) | `origin/main == 1d67e4fd`; candidate and rollback ids equal the packet; production on the exact `g94705764` trio, restarts 0, HTTP 200; VIS-PAG-01 (#38 @ `838df0f8`) outside the lane; roster 12 / digest `3daf1f07…` / journal 20; `.env` `5155578153d44336…`, `elmo.yaml` `126b284be3c3e118…`; disk C 37.5 GB / D 39 GB |
| Cutover | 2026-09-12T14:56:42.9Z `gen-prod-env.cjs … g1d67e4fd` (`.env` byte-identical; `elmo.yaml` diff = header + exactly the three `image:` lines) + `docker compose up -d --no-build`; db-migrate exit 0; web HTTP 200 at 14:56:57.3Z (**≈14 s**, 8 non-200 probes at 0.5 s) |
| Post-cutover state | web `2efd71b2…` / worker `6da0950e…` running, restarts 0, handlers registered; journal 21; 12 competitors, 12 active, digest unchanged, index present; 33 chain jobs `created`, next 20:57:31Z unchanged; `.env` unchanged, `elmo.yaml` `b49592dbc27446c9…` |

## V-Model traceability (SENT-R0 rows of the matrix)

| Test | Evidence |
|---|---|
| UT-ID-001 / UT-ID-002 | `packages/lib/src/db/__tests__/competitors.test.ts` — 16 tests: unchanged / update / insert / deactivate / reactivate by id / reuse by unique domain / never by name; unknown or duplicate id, duplicate domain, ambiguous reactivation rejected |
| IT-ID-001 | 0020 on the populated test DB and on the restored production copy: id digest identical, all rows active; empty-DB chain 0000→0020 OK |
| IT-ID-002 / IT-ID-003 | `competitor-identity.integration.test.ts` 8 tests (no-op save, edit, remove, reactivate by id / by domain, ambiguous / cross-brand / duplicate rejections) — 9/9 with `save-prompts` |
| IT-ID-004 | public DELETE soft-removes (Bruno collection 60/60 requests, 126/126 assertions ×3 runs) |
| REG-ID-001 | `pnpm test` lib 661 / web 528 / config 93 / cli 28 / cloud 43; Storybook 161/161; Playwright `local` 114/114 (Visibility, SoV, Citations, Opportunities, onboarding, settings, prompt history, worker report) |
| E2E-ID-001 | `e2e/tests/local/competitor-identity.spec.ts` 4 tests (UI save round trip keeps ids, edit records previous name, remove hides everywhere current, re-add by domain reuses id) — local and CI |
| Rehearsal (restored production data) | 17/17: two genuine Settings-UI saves, all 12 ids and business fields identical afterwards, no inactive/duplicate rows; adjacent pages OK; rollback to `g94705764` 11/11 |
| Production acceptance | below |

## Real-life production acceptance (14:57Z) — PASS, zero provider calls

The production Save button cannot represent an unchanged payload (the bar renders only when the pending list differs from the loaded one), so the real UI interaction is proven by the 17/17 restored-data rehearsal, and production verified the identical authenticated server-function path:

| Check | Result |
|---|---|
| session | the operator's existing production session reused (newest valid `session` row, signed in-process); nothing minted, edited or deleted — the table still holds exactly that one row (Better Auth's own sliding-expiry refresh moved `updated_at`/`expires_at` on use) |
| invocation | from the loaded Settings › Competitors page, the page's own bound `updateCompetitors` stub (`serverFnMeta.id 0deaa40d…`, `url /_serverFn/0deaa40d…`) called **once** with exactly the 12-row roster the page's bound `getCompetitors` returned (ids + trimmed name/domains/aliases, same order = the page's `saveable()` derivation); server returned the same 12 active ids in 48 ms |
| zero DML | SQL before/after of all 12 rows — id, brand_id, name, domains, aliases, active, removed_at, previous_names, created_at, updated_at, **xmin** — byte-identical; row count 12, active 12, digest `3daf1f07…` unchanged; `pg_stat_user_tables` ins/upd/del/hot_upd for `competitors` unchanged |
| pages | Settings lists 12/12 (`12/500`); Visibility (leaderboard 12/12 names), Share of Voice, Citations, Settings › Prompts, prompt detail (responses tab) HTTP 200 with headings |
| Opportunities | **skipped in production by explicit operator exception** (its on-demand generation would issue a provider call); rehearsal evidence retained (HTTP 200 on candidate and rollback image) |
| provider calls | 0 — `usage_events`, `prompt_runs` and pg-boss jobs created since the cutover all 0; worker log 0 provider/error lines |
| health | restarts 0, HTTP 200, journal 21, images == candidate, chain jobs unchanged |

## Operational note

During the CP7 wait, Windows auto-updated WSL to 2.7.14.0 (10:16Z), restarting the Docker Desktop engine; the `elmo` containers died ungracefully (Postgres WAL recovery clean) and the `aitrckr-elmo-watchdog` restarted the unchanged `g94705764` stack at 10:20:55Z with data intact; no run was due in the gap. Not related to SENT-R0; recorded because an OS-level WSL update can restart the engine at any time, including during a cutover.

## Scope declarations

- Only SENT-R0 is deployed: no sentiment tables, jobs, classifier, page or provider calls exist yet. SENT-R1/R2 starts from `main` containing this release in a new worktree/branch.
- Onboarding dedupes against active rows only; a later id-less re-add of a domain shared by an inactive and a new active row is rejected as ambiguous (safe, not silent).
- Recovery assets: `D:\ELMO-Recovery\SENTR0-CompetitorIdentity-20260912\` (JIT dump + sha256 + counts, `elmo-images-g1d67e4fd.tar`, `aitrckr-sent-r0-2026-09-12.bundle`, `SHA256SUMS.txt`).
