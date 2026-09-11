# F-08 Competitive AI Visibility Overview — production closeout

Status: **PASS / CLOSED** 2026-09-11. Raw evidence (logs, results, screenshots): operator-private `~/.elmo/f08-evidence/` (`cp0.md`, `cp1.md`, `cp3.md`, `images.md`, `rehearsal.md`, `deploy-packet.md`, `pr-body.md`, `cutover/`, `live/`, `rehearsal/`, `rehearsal-after-rollback/`, `screenshots/`). Recovery assets: `D:\ELMO-Recovery\F08-CompetitiveAiVisibility-20260911\` (pre-cutover dump + sha256 + counts, `elmo-images-g909e8d86.tar`, `aitrckr-f08-2026-09-11.bundle`, `SHA256SUMS.txt`).

## Identities

| Item | Value |
|---|---|
| Starting baseline (CP0, main = origin/main = peeled `production/f07-competitor-sov-trends-2026-09-06`) | `9106fcf9cb2e4e444912671d4199159579a970b6`; production source `c8d18032…`, images `gc8d18032`; F-04, F-06 (R1+R2), F-07 CLOSED; no open PR, no upstream sync. CP0 was business-data read-only but not zero-write: the browser-auth setup created and deleted three `session` rows (fully reverted, count 1 → 1) — recorded as a procedural deviation; every later production checkpoint reused the operator's existing session instead |
| Feature PR | [#29](https://github.com/e-orlov/aitrckr/pull/29), head `6d0387d6`, required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit all success, mergeable CLEAN against unchanged `main` |
| Application source (`F08_FEATURE_MERGE_SHA`) | `909e8d860d688ae851dfe229d26414f363736f75` — squash merge of #29 (tree identical to the branch head); post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check all success |
| Images (built once 2026-09-07T07:23–07:41Z from a clean detached worktree at the source commit, isolated config dir `%USERPROFILE%\.elmo-build`, project `elmo-build`) | `elmo-web:g909e8d86` `sha256:72e64000d0aa7f27bf1dfeb19183fadb74206e47d73755104cd357792afd9aa4`; `elmo-worker:g909e8d86` `sha256:f79d5766deebf720284cf6d36bf18613b710816e7a9e5efd2f294f4819cde127`; `elmo-db-migrate:g909e8d86` `sha256:e61b0087462128f3b5bfe11d5e7bd2057316ba6220c5e356edec5e8ffab22b59`; never rebuilt or re-tagged; the same IDs ran in rehearsal, rollback→redeploy and production. **The images carry no OCI source/revision label** (only Compose labels; the Dockerfile sets none — same as every earlier production build): provenance is the single-tag build record from the detached worktree, not a label |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, volume `elmo_postgres_data`, container not recreated (started 2026-09-08T23:00:29Z before and after the cutover) |
| Migration journal | 20 before and after (F-08 has no migration; `packages/lib/src/db/migrations`, `schema.ts` and the lockfile are identical between `9106fcf9` and `909e8d86`) |
| Rollback target | `gc8d18032` trio (web `0061da7b36b5`, worker `53585aa16245`, db-migrate `880dc0a95055`), present locally; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo gc8d18032` + `docker compose up -d --no-build` with `COMPOSE_FILE="%USERPROFILE%\.elmo\elmo.yaml;docs/phase1/ops/prod-env.override.yaml"` (rehearsed both ways on the restored copy: previous compact bar back, then F-08 back with identical IDs, journal 20 each time) |
| Pre-cutover backup | `elmo-prod-pre-f08-cutover-20260911-075629.dump` 2,721,867 B sha256 `88e768763c7932601ee357635fa45cb0573e0a9a06ea111407b0daf198a1c91a`, TOC 197 entries, restored in a disposable network-less pinned container with identical counts (brands 1 / prompts 33 / enabled 33 / competitors 12 / runs 463 / citations 1,334 / journal 20 / users 1 / sessions 1) and identical `prompt_runs` (`67a23e72…`), `citations` (`0e7c8c7f…`) and `prompts` (`39cb90f7…`) digests; earlier rehearsal dump `…pre-f08-rehearsal-20260907-074241.dump` (2,164,099 B, `afa69fee…`) proved the restore procedure on 09-07 |
| Explicit approval | Deploy packet presented 2026-09-11 07:12Z; user **PRODUCTION GO** for exactly `SOURCE_SHA=909e8d86…`, `IMAGE_TAG=g909e8d86`, `ROLLBACK_TAG=gc8d18032`, journal 20, with the pre-existing OpenRouter incident explicitly accepted as a separate operational issue |
| Pre-cutover revalidation (07:55Z) | origin/main and the detached build worktree at `909e8d86` (clean); candidate IDs equal the packet; production running the exact `gc8d18032` trio; `.env` `5155578153d44336`, `elmo.yaml` `439edb878d301966`; journal 20/20; postgres healthy, HTTP 200, restarts 0; no other compose operation on project `elmo`; next `process-prompt` job 08:57Z (quiet window); C: 52.7 GB / D: 53.7 GB free |
| Cutover | 2026-09-11T07:57:49.9Z `docker compose up -d --no-build` (project `elmo`, `elmo.yaml` + `prod-env.override.yaml`) after `gen-prod-env.cjs … g909e8d86` (`.env` byte-identical; `elmo.yaml` and the rendered compose config differ only in the three image lines + render timestamp); db-migrate exit 0 ("migrations applied successfully"), journal 20, web HTTP 200 at 07:58:02.0Z (**≈12 s**); postgres container untouched |
| Post-cutover state | web / worker / db-migrate on the exact candidate IDs, restarts 0, `.env` hash unchanged, `elmo.yaml` `31a6543b62572651`; web and worker logs 0 application errors since cutover |
| Real-life acceptance | 2026-09-11T07:59:00–07:59:33Z read-only oracle run against the production UI with the operator's existing session (no session minted or deleted; the token never left the driver process) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- The **Visibility** page opens with three cards above the existing per-prompt cards, in the Share of Voice page's composition: **AI Visibility** (headline own-brand Visibility, subtitle with the real snapshot denominators, concentric radial rings for the brand and its top six competitors on a common 0–100% scale over full background tracks — no donut, no normalisation, no "Others"), **Visibility Trends** (brand + top six as independent lines on a fixed 0–100% axis, one tooltip shared across the plot, clickable legend, brand first) and **Visibility Leaderboard** (brand plus every tracked competitor: rank, logo, `You` badge, absolute 0–100% bar, Visibility, `Visible prompts x (z%)`, `Evaluated prompts y`).
- One canonical Visibility definition: the existing per-prompt LVCF (each prompt seeded with its earliest observation and carried forward; per-day sums; `mentioned ÷ runs`, rounded once at display; current = last non-null point) applied to the brand and to each competitor over the same denominator. Competitor runs are counted once per run (`count(DISTINCT id)`), so a name repeated inside one `competitors_mentioned` array is one observation. Percentages are independent and may sum above 100%. Coverage = distinct evaluated prompts whose carried observation mentions the entity ÷ prompts with ≥ 1 eligible observation.
- Full filter parity with the page — lookback, model, tags, **search `q`** and timezone are in the server validator and the query key; `order` only reorders the prompt list; an empty resolution returns the empty payload without any run query. The compact own-brand bar is no longer mounted on this page (its prompts / runs / citations figures moved into the AI Visibility card); `getFilteredVisibilityFn` and the Overview remain the canonical reference and are untouched.
- Server: `getCompetitiveVisibilityFn` (auth → brand access → `resolveFilteredPrompts` → three parallel reads incl. the new `getPerPromptDailyCompetitorRuns` → pure `computeCompetitiveVisibility`); bounded payload (≤ 7 series, raw counts, no prompt ids/text). Entity identity = competitor UUIDs; observations matched by the competitor's current name (the only link `prompt_runs.competitors_mentioned` offers) — a rename disconnects older history, documented, no migration.

## Requirement traceability

| Requirement | Evidence | Status |
|---|---|---|
| MET-01 canonical invariant | unit: brand series == `applyPerPromptLVCF` on every day; production: Overview hero **45%** == new headline 45% (default scope) | PASS |
| MET-02 per-entity formula, shared denominator, binary per run, Σ > 100 | mandated fixture (4 runs / 3 prompts → 50 / 50 / 25, Σ 125%, coverage 2/3, 1/3, 1/3) + detectors; production Σ of visibilities 114% (default) | PASS |
| MET-03 prompt coverage `x (z%)` / `y` | unit + stories (`14 (42%)` / `33`); production `15 (45%)` / `33` for ARAG, every row `33`, `x ≤ y` | PASS |
| MET-04 snapshot consistency | server test + production: radial legend value == leaderboard value == right-edge tooltip for every roster entity in 5 scopes | PASS |
| VIZ-01 radial (no donut) | stories (N background tracks, no `.recharts-pie`, a11y label); production 7 tracks, 0 pies, 0 "Others" | PASS |
| VIZ-02/03/04 trend (Top 6, frozen roster, 0–100 axis, null gaps, clickable legend) | unit roster/tie-break; stories; E2E axis labels; production first/middle/last tooltips == oracle, legend toggle hides/restores | PASS |
| VIZ-05 leaderboard (all competitors, 0% rows, You badge, absolute bars, coverage group) | stories; production 13 rows incl. D.A.S. / DEVK / ROLAND at `0%` `0 (0%)`, bar widths == values | PASS |
| FLT-01/02/03 filter parity incl. `q`, empty resolution, single header/filter bar | server tests (tags OR + system tag, `q`, model, tz, `all`, empty → no reads); E2E; production model / tag / q / 1w scopes == oracle | PASS |
| Backend contract (auth, tenancy, 3 reads, bounded payload, DB error propagates) | server tests: unauthenticated & cross-tenant rejected before any read; production payload ≤ 38.6 KB, 41–165 ms | PASS |
| States (loading, refetch, empty, brand-only, 0 %, error isolated, sparse) | stories; E2E error isolation (prompt list stays) | PASS |
| Responsive / dark / a11y | stories + E2E; production 375 px overflow 0 with tooltip inside, dark tooltip surface `oklch(0.141 0.005 285.823)` | PASS |
| Regression (Overview, F-07 SoV, Citations, per-prompt cards) | files untouched; production Overview 2 areas / 0 F-08 elements; SoV 1 donut + 8 lines incl. Others, leaderboard shares sum 102 (rounding); Citations OK; 4 prompt cards below the section, deep link opens `/prompts/<id>` | PASS |
| Zero migration / dependency / write path / provider call | structural zero-diff; worker log 0 provider lines since cutover | PASS |
| Lifecycle | PR #29 → 5 required checks → squash → post-merge CI → immutable trio → isolated rehearsal + oracle → rollback rehearsal → fresh verified backup → explicit GO → `--no-build` cutover → live oracle acceptance → this closeout, tag and release | PASS |

## Verification

| Check / command | Exit | Tests / assertions | Result |
|---|---:|---:|---|
| `pnpm lint` (719 files) | 0 | 0 errors | PASS |
| `pnpm -r --if-present check-types` | 0 | 13/13 | PASS |
| `pnpm test` | 0 | web 511 (+22 unit, +14 server) · lib · config 93 · cloud · cli 28 | PASS |
| `pnpm test:scripts` | 0 | 30/30 | PASS |
| `pnpm -C apps/web test:storybook` | 0 | 141/141 (+10) | PASS |
| `pnpm build` + `check-server-bundle.mjs` | 0 | 16/16, client `visibility-*.js` chunk free of database code | PASS |
| `pnpm license-check` | 0 | 1,260 compliant | PASS |
| Playwright `local` F-08 spec (test stack rebuilt from the branch) | 0 | 6/6 (independent oracle, filters, error isolation, narrow/dark, Overview/SoV/Citations) | PASS |
| Playwright `local` full | — | 99 passed / 2 worker-gated skips / 1 unrelated `prompt-save-rollback` tag-combobox timeout under 4 workers that passes alone (6.5 s) | PASS (with note) |
| PR #29 required checks; post-merge `main` workflows | — | 5/5; 4/4 | PASS |
| Rehearsal live-verify (`e2e/f08-live-verify.local.mts`, restored 09-07 dump, `g909e8d86`) | 0 | 5 scopes × 3 dates, API == UI == oracle, narrow/dark/overview/SoV/citations, 0 errors | PASS |
| Rollback rehearsal (`gc8d18032` → `g909e8d86`) | 0 | old bar back / F-08 back, identical IDs, journal 20 both ways, live-verify PASS again | PASS |
| Production live-verify (`127.0.0.1:1515`, existing session, `DB_CONTAINER=elmo-postgres-1`) | 0 | 5 scopes × 3 dates, reconciliation, legend toggle, narrow/dark/overview/SoV/citations, 0 errors, 33 s | PASS |

## Structural zero-diff proof (`git diff 9106fcf9..909e8d86`)

```
new DB migrations: 0            new routes/menu entries: 0        new queues/jobs/schedulers: 0
schema changes: 0               new public API operations: 0      new production write paths: 0
new runtime dependencies: 0     new provider/LLM calls: 0         Overview / dashboard / analysis / share-of-voice files changed: 0
new SQL read functions: 1 (getPerPromptDailyCompetitorRuns, distinct runs per prompt/day/competitor)
```

19 files, +3,166 / −4: `competitive-visibility.ts` (+ tests), `postgres-read.ts` (one read), `server/competitive-visibility{,-load}.ts` (+ tests), hook, 5 components, `prompts-display.tsx` (composition), stories + fixtures + Storybook mock/alias, E2E spec, changeset, 7 PNG screenshots.

## Rehearsal (2026-09-07 07:43–07:50Z, project `elmo-f08-rehearsal`, own config dir/network/volume, loopback 1516/5434, `SCRAPE_TARGETS=stub:stub`)

Dump `…pre-f08-rehearsal-20260907-074241.dump` restored identical (356 runs, journal 20). db-migrate exit 0, journal 20/20. Brand `arag`, Europe/Berlin, default window 08-07…09-07: 58 carried runs, 33 evaluated prompts, ARAG 22 → **38%**, 15 (45%); Top 6 ADAC, WGV, HUK-COBURG, AUXILIA, Allianz, DEURAG; Σ visibilities 91%. Model, tag (29 runs / 16 prompts, 31%), q (2 / 1, 0%) and 1w scopes all API == UI == oracle at first/middle/last dates; Overview hero 38% == headline; SoV 8 lines, shares sum 101. The copy's worker later ran 33 due jobs with the **stub** provider (no network) — the rollback comparison and a second live-verify were done on that changed copy (default 6/41 = 15% on both the old bar and the new headline; `model=chatgpt::premium` still 22/58 = 38%, proving filter isolation). Cleanup `down -v` on that project only.

## Production acceptance (2026-09-11T07:59:00–07:59:33Z, read-only, brand `arag`, Europe/Berlin, existing operator session)

Independent oracle: SQL per-prompt/day runs, brand runs and `count(DISTINCT id)` competitor runs (enabled prompts, tag/search semantics, grounded model rule) → per-prompt carry seeded with the earliest observation → last day with runs → per-entity `mentioned ÷ runs`, visible prompts, evaluated prompts → Top 6 by mentions desc, name, id. Compared with the decoded `getCompetitiveVisibilityFn` payload and the rendered UI.

| Scope | asOf | Carried runs | Evaluated | Window runs | ARAG | Σ | Trend roster | API | UI | Tooltip dates |
|---|---|---:|---:|---:|---|---:|---|---|---|---|
| default 1m | 2026-09-11 | 49 | 33 | 463 | 22 → **45%**, 15 (45%) | 114% | ARAG, WGV, HUK-COBURG, ADAC, ADVOCARD, AUXILIA, DEURAG | == | == | 08-11 / 08-26 / 09-11 == |
| model=chatgpt::premium | 09-11 | 49 | 33 | 463 | 45% | 114% | same | == | == | == |
| tags=rechtsschutz | 09-11 | 25 | 16 | 227 | 9 → 36%, 7 (44%) | 120% | ARAG, WGV, HUK-COBURG, ADAC, AUXILIA, ÖRAG, Allianz | == | == | == |
| q=anwalt | 09-11 | 2 | 1 | 16 | 1 → 50%, 1 (100%) | 50% | ARAG + six 0% competitors (code-unit name order) | == | == | == |
| lookback 1w | 09-11 | 49 | 33 | 244 | 45% | 114% | as default | == | == | 09-05 / 09-08 / 09-11 == |

Leaderboard (default): ARAG 45% 15 (45%) · WGV 20% 6 (18%) · HUK-COBURG 18% 5 (15%) · ADAC 10% 5 (15%) · ADVOCARD 4% 1 (3%) · AUXILIA 4% 2 (6%) · DEURAG 4% 2 (6%) · ÖRAG 4% 2 (6%) · Allianz 2% 1 (3%) · R+V 2% 1 (3%) · D.A.S. 0% 0 (0%) · DEVK 0% 0 (0%) · ROLAND 0% 0 (0%) — Evaluated 33 on every row; right-edge tooltip rows identical; radial legend identical; legend swatch == bar colour == trend stroke per entity. Legend toggle hides/restores a line. Narrow 375 px: overflow 0, tooltip inside. Dark: tooltip surface `oklch(0.141 0.005 285.823)`. Overview hero **45% == headline**, 0 F-08 elements, 2 areas. Share of Voice: 1 donut, 8 lines, legend ARAG · WGV · HUK-COBURG · ADAC · ADVOCARD · AUXILIA · DEURAG · Others, shares sum 102, 0 F-08 elements. Citations heading OK. Prompt cards below the section (first card starts below the section), deep link opens `/app/org/default/brand/arag/prompts/<id>`. consoleErrors [] · pageErrors [] · failed same-origin requests []. `getCompetitiveVisibilityFn` 7 calls 41–165 ms ≤ 38.6 KB. Business data: `prompt_runs` 463 / `citations` 1,334 / `prompts` 33 digests identical before and after cutover and acceptance; `session` count 1, `updated_at` unchanged (no session minted, deleted or refreshed); no evidence file contains the token. Cross-tenant denial is covered by the server tests (production has a single organization/brand); two hand-replayed RPC probes at 08:02:42Z produced two transport-level `Internal Server Error` log lines (malformed server-function requests from the probe, own-brand and foreign alike) — probe artifacts, not application errors. Screenshots `~/.elmo/f08-evidence/live/00…10.png`.

## Pre-existing production incident (not caused by F-08, tracked separately) — RESOLVED 2026-09-11

Cause: the **cumulative spend limit configured on the production OpenRouter API key** (non-resetting, `limit_reset: null`) was reached; account credits were available throughout. Unrelated to F-08: the deployment changed neither the API key, budget, provider configuration nor the scheduler.

Timeline (UTC): last successful ELMO run before the gap **2026-09-08 21:17Z**; observed 403 period (`OpenRouter API error (403): Key limit exceeded (total limit)` on every `process-prompt` job) **≈2026-09-09 07:52Z through 2026-09-11 02:57Z**; key limit raised to USD 100 by the operator and key-level access confirmed by a direct HTTP 200 diagnostic request **before the F-08 cutover** (07:57Z); F-08 acceptance (07:59Z) correctly made **zero post-cutover provider calls**, and the dataset was still unchanged during acceptance because the first natural job had not yet become due (08:57Z) — the carried values in the acceptance tables above are therefore the frozen 2026-09-08 snapshot; **natural ELMO ingestion resumed at 2026-09-11 08:57:10Z** with the first naturally scheduled job (pg-boss `4f1df0b6…`, prompt `3bca6cf0…`, `completed`, retry 0, `prompt_runs` `af2b85ce…` via the configured `chatgpt:openrouter:openai/gpt-5.6-luna:online` target, genuine provider response, 1 citation, no duplicate, no 403 or other provider error, next recurrence enqueued for 20:57Z). No manual, forced or rescheduled job was used and no production configuration was touched.

Read-only re-run of the live-verify oracle at 09:01Z after the new row: API == UI == oracle in all 5 scopes (default now 44%, 21/48 carried runs, 464 window runs; Overview hero == headline; SoV and Citations intact; 0 errors). The ≈2-day data gap (2026-09-08 21:17Z → 2026-09-11 08:57Z) was **not backfilled** and remains in the history. F-08 application code, images and production configuration required no correction. Evidence: `~/.elmo/f08-evidence/openrouter-recovery.md` + `openrouter-recovery/live/`.

## Residual risks

| Risk | Owner | Follow-up |
|---|---|---|
| OpenRouter key-limit incident — resolved 2026-09-11 08:57Z, see above; the key limit is still cumulative (no reset) | operator | clear the per-key limit or set a monthly reset so the cumulative cap cannot recur; the 2026-09-08 → 09-11 gap stays in the history |
| Images carry no OCI source/revision label | operator | optional build-time `org.opencontainers.image.revision` label in `docker/Dockerfile` (separate small ticket) |
| `generateDateRange` (shared helper) drops the last day of a DST-crossing window when Node runs in a DST timezone; production containers run in UTC and are unaffected | operator | separate small ticket |
| Competitor identity by current name (`competitors_mentioned` stores names) — a rename disconnects older mentions for F-07 and F-08 alike | — | documented limitation |
| Storybook vitest browser does not render Recharts axis tick labels; the fixed 0–100 axis is asserted with real CSS in Playwright | — | none |
| `prompt-save-rollback` tag-combobox E2E is timing-sensitive under 4 workers (passes alone) | operator | observe |
| Leaderboard at 375 px scrolls horizontally inside its card (page overflow 0) | — | none |
