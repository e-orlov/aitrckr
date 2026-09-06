# F-07 Competitor Share of Voice Trends — production closeout

Status: **PASS / CLOSED** 2026-09-06. Raw evidence (logs, results, screenshots): operator-private `~/.elmo/f07-evidence/` (`cp0.md`, `cp1.md`, `cp6.md`, `images.md`, `rehearsal.md`, `deploy-packet.md`, `screenshots/`, `rehearsal/`, `live/`). Recovery assets: `D:\ELMO-Recovery\F07-CompetitorSovTrends-20260906\` (dump + sha256 + counts, `elmo-images-gc8d18032.tar`, `aitrckr-f07-2026-09-06.bundle`, `SHA256SUMS.txt`).

## Identities

| Item | Value |
|---|---|
| Planning baseline | `33c94cd175f9b128cfd03901ff04ab51fc189f45` (audit of 2026-09-04) — context only; none of the F-07 files changed between it and the start SHA |
| Starting baseline (main = origin/main = peeled `production/f06-owned-citation-structure-closeout-r2-2026-09-06`) | `518c138c95bf7103254af199c329259059b16326`; production source `48e697837045c585ffaf32d821dcf601f841ab5d`, images `g48e69783` (web `6891e26bc69f`, worker `8842d34fe941`, db-migrate `167d86d1c39b`); diff `48e69783..518c138c` = 12 docs/ops/test files, all documented in the F-06 closeouts (no runtime code); F-04 and F-06 (R1+R2) CLOSED; no open PR, no upstream sync |
| Feature PR | [#27](https://github.com/e-orlov/aitrckr/pull/27), head `d0e2f704`, required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit all success, mergeable CLEAN against unchanged `main` |
| Application source (`F07_FEATURE_MERGE_SHA`) | `c8d18032f9b181f2a00d1ee0a6025760333b159d` — squash merge of #27; post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check all success |
| Images (built once 2026-09-06T16:42–17:00Z from a clean detached worktree at the source commit, isolated config dir `%USERPROFILE%\.elmo-build`, project `elmo-build`) | `elmo-web:gc8d18032` `sha256:0061da7b36b51ee68490e46b44762b75ab9c9ea938c5641ecdd27ac940c8d5b4`; `elmo-worker:gc8d18032` `sha256:53585aa16245ecd707681058f98d20579d05e2ec4a887398f49bec5545c87d88`; `elmo-db-migrate:gc8d18032` `sha256:880dc0a9505597b51966e0b5b93dc64879874f9feadf5f084c55e20c20d49523`; never rebuilt or re-tagged after capture; the same IDs ran in rehearsal, rollback→redeploy and production |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, volume `elmo_postgres_data`, container not recreated (started 2026-09-06T05:26:57Z before and after) |
| Migration journal | 20 before and after (F-07 has no migration; `packages/lib/src/db/migrations` identical between `518c138c` and `c8d18032`) |
| Rollback target | `g48e69783` trio above, present locally; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo g48e69783` + `docker compose up -d --no-build` (rehearsed on the restored copy: previous single-series area chart back, headline unchanged, journal 20) |
| Pre-deploy backup | `elmo-prod-pre-f07-cutover-20260906-171236.dump` 1,953,979 B sha256 `d61390cff2e9f86c3028d5dd88acf680983203733295dc2a16e6b453fc25ea54`, TOC 197, restored in a disposable pinned container with identical counts (brands 1 / prompts 33 / enabled 33 / runs 319 / citations 932 / journal 20 / users 1 / sessions 1) and prompt_runs digest `086425e1…` |
| Explicit approval | Deploy packet presented; user **GO** for exactly `SOURCE_SHA=c8d18032…`, `IMAGE_TAG=gc8d18032`, `ROLLBACK_TAG=g48e69783`, `EXPECTED_MIGRATION_JOURNAL=20`; pre-cutover re-check: all three local image IDs equal the packet, rollback trio present, `.env` 5155578153d44336 / `elmo.yaml` 1690d903f0f175c3 unchanged, journal 20, HTTP 200, no other compose operation running |
| Cutover | 2026-09-06T17:48:06Z `docker compose up -d --no-build` (project `elmo`) after `gen-prod-env.cjs … gc8d18032` (17 `.env` keys kept byte-identical; `elmo.yaml` differs from the previous file only in the render timestamp and the three image tags); db-migrate exit 0, web HTTP 200 at 17:48:20Z (≈14 s); next scheduled prompt job 18:06:30Z untouched |
| Post-cutover state | web `587db2152599` / worker `c0058ebaaa37` / db-migrate `6673b039d9e2` on the exact IDs above, restarts 0; `.env` hash unchanged, `elmo.yaml` 439edb878d301966; web and worker logs 0 errors since cutover |
| Real-life acceptance | 2026-09-06T17:48:51–17:49:14Z read-only oracle run against the production UI (below) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- The existing **Share of Voice Trends** card (Share of Voice page only) renders a Recharts `LineChart`: own brand (`BRAND_COLOR`, 2.75 px), up to six competitors (`COMPETITOR_PALETTE` in frozen rank order, 1.75 px), and **Others** (`OTHERS_COLOR`, 1.5 px, dashed) — unfilled lines, no per-day dots, active dots at the selected date, Recharts' vertical cursor as guide, entrance animation following `prefers-reduced-motion`.
- One tooltip shared across the plot (`Tooltip` axis mode, `isAnimationActive={false}`): pointer anywhere in the plot selects the nearest date; the content is built from the ordered series metadata and the active row — long date, then brand → competitors in rank order → Others — every share rounded once (`Math.round(value) + "%"`), actual zeros shown as `0%`, null (no denominator) rows omitted.
- A compact wrapping static `<ul aria-label="Series">` legend below the plot with the same colours/order, a dashed cue for Others, and the full name in `title`; no interactivity.
- Server: `getShareOfVoiceFn` returns an additive `comparisonTrend { series[], points[] }` computed by the pure `shareOfVoiceComparisonTimeSeriesLVCF` from the same three existing reads and date range. Whole per-prompt `{brand, competitors}` snapshots are pre-seeded with the earliest observation and replaced atomically (a competitor missing from a new run is zero). Top 6 = competitors with positive last-day carried counts sorted by the new shared `compareMentionsDescThenName` (mentions desc, then name by code unit — also applied to `shareOfVoiceLeaderboardLVCF` and `computeShareOfVoice`, brand ahead on a tie), frozen for the axis; Others = sum of every other competitor's counts before division; denominator = brand + all competitors. Keys `brand`, `competitor-1..6`, `others`; names are labels. `shareTimeSeries`, `entries`, `brandShare`, `totalRuns`, `model` unchanged; the Overview keeps consuming `shareTimeSeries` through the untouched `TrendChart`.
- Filter, auth, tenancy, loading, empty and no-match behaviour unchanged (server tests + E2E).

## Requirement traceability

| AC | Evidence | Status |
|---|---|---|
| AC-01 existing page only | page diff swaps one card body; E2E: same sidebar (no trend item), 3 cards, 1 table, 2 charts; production rail unchanged | PASS |
| AC-02 bounded series | UT-09/22; server test ≤ 8 series; Storybook; E2E legend; production 8 series (brand + 6 + Others) | PASS |
| AC-03 frozen deterministic Top 6 | UT-10/11/23; E2E tie at rank 6/7 (WGV excluded by name) and all-tied chatgpt case; production ÖRAG/ADAC order flipped between rehearsal (ÖRAG 3 = ADAC 3, name order) and live data (ÖRAG 4 > ADAC 3) exactly as the rule predicts | PASS |
| AC-04 complete denominator | UT-04/25; oracle denominators 41/53 (production) incl. tail counts | PASS |
| AC-05 atomic snapshot LVCF | UT-06/07/08; E2E ghost-drop run (middle-date zeros); oracle carries whole snapshots | PASS |
| AC-06 legacy brand equality | UT-19 all dates; server test; production headline 36% == comparison brand 36% | PASS |
| AC-07 count-level Others | UT-14/15/16/17; E2E; production Others 3/53 → 6% == leaderboard tail DEURAG 2 + ROLAND 1 | PASS |
| AC-08 line styling | Storybook/E2E stroke/width/dash/fill assertions; production styles `#2563eb 2.75 solid`, six palette lines `1.75 solid`, `#cbd5e1 1.5 5 4` | PASS |
| AC-09 static legend | Storybook/E2E order, dashed cue, `title`, below plot, wraps at 375 px (56 px high, no overflow) in rehearsal and production | PASS |
| AC-10 plot-area nearest-date hover | E2E/Storybook/production pointer at the top grid line (no line there) at first/middle/last dates; one-step-left = previous day | PASS |
| AC-11 stable complete tooltip | first/middle/last rows in fixed order incl. `0%` rows (E2E) — production rows below | PASS |
| AC-12 dots/guide | 8 active dots + 1 cursor at every compared date (Storybook, E2E, rehearsal, production) | PASS |
| AC-13 edge positioning | right-edge tooltip inside viewport, page overflow 0 at 1400 px and 375 px (E2E, rehearsal, production) | PASS |
| AC-14 cross-surface reconciliation | UT-20; server test; production headline 36% == brand cell 36% == last point; competitor cells 17/15/9/8/6/4 == tooltip; tail 3/53 → 6% == Others | PASS |
| AC-15 filter parity | server tests (tags, system tags, model, timezone, `all`, no-match without read); E2E; production model/tag/lookback/reload scopes all PASS | PASS |
| AC-16 Overview unchanged | `index.tsx`/`trend-chart.tsx` untouched; E2E; production Overview 1 area / 0 line curves / 0 F-07 elements | PASS |
| AC-17 auth/privacy | server auth-before-read tests; payload keys bounded, no prompt ids/text; production payload ≈21 KB | PASS |
| AC-18 zero migration/dependency/query/write | structural zero-diff below | PASS |
| AC-19 state/theme/responsive | Storybook matrix (3 competitors, Top 6 + Others, narrow, dark, null day, brand only, empty); E2E narrow/dark/reduced-motion; production dark + narrow | PASS |
| AC-20 lifecycle | PR #27 → required checks → squash → post-merge CI → immutable trio → isolated rehearsal → rollback rehearsal → verified backup → explicit GO → `--no-build` cutover → live oracle acceptance → this closeout, tag and release | PASS |

## Verification

| Check / command | Exit | Tests / assertions | Duration | Result |
|---|---:|---:|---:|---|
| `pnpm lint` (705 files) | 0 | 0 errors | 2.3 s | PASS |
| `pnpm -r --if-present check-types` | 0 | 13/13 | — | PASS |
| `pnpm test` | 0 | lib 633 · web 475 (+29 stats, +13 server) · config 93 · cloud 43 · cli 28 | — | PASS |
| `pnpm test:scripts` | 0 | 30/30 | — | PASS |
| `pnpm -C apps/web test:storybook` | 0 | 131/131 (+8) | 24 s | PASS |
| `pnpm build` + `check-server-bundle.mjs` | 0 | 16/16, clean tree, client assets free of database code | 1 m 36 s | PASS |
| `pnpm license-check` | 0 | 1,260 compliant | — | PASS |
| Playwright `local` F-07 spec (test stack rebuilt from the branch) | 0 | 6/6 | 39 s | PASS |
| Playwright `local` full | — | 94 passed / 2 worker-gated skips / 1 unrelated prompt-editor timing failure (`phase1-flows` unsaved-changes bar) that passes alone (2.9 s vs 17 s under 4 workers) | 1.1 m | PASS (with note) |
| PR #27 required checks; post-merge `main` workflows | — | 5/5; 4/4 | — | PASS |
| Rehearsal live-verify (`e2e/f07-live-verify.local.mts`, restored dump, `gc8d18032`) | 0 | 6 scopes, 11 date comparisons, reconciliation, narrow/dark/overview/citations, 0 errors | 40 s | PASS |
| Rollback rehearsal (`g48e69783` → `gc8d18032`) | 0 | old chart back / new chart back, journal 20 both ways | — | PASS |
| Production live-verify (`localhost:1515`, `DB_CONTAINER=elmo-postgres-1`) | 0 | 6 scopes, 11 date comparisons, reconciliation, narrow/dark/overview/citations, 0 errors | 23 s | PASS |

Pure-builder benchmark: 40 prompts × 31 days × 12 competitors (785 + 6,280 rows) → 8 series, 31 points, 7.8 KB, 3.1 ms/call. Production Share of Voice server function: 39–275 ms (cold) / ≈50 ms warm, ≈21.3 KB response including the 32-point × 8-series trend; still exactly three parallel reads.

## Structural zero-diff proof (`git diff 518c138c..c8d18032`)

```
new DB migrations: 0
schema changes: 0
new runtime dependencies: 0
new SQL read functions/queries: 0
new routes/menu entries: 0
new public API operations: 0
new provider/LLM calls: 0
new external fetches: 0
new queues/jobs/schedulers: 0
new production write paths: 0
Overview comparison series added: 0
```

12 files, +2,221 / −23: `visibility-stats.ts`, `analysis.ts`, `share-of-voice-palette.ts`, `share-of-voice-trend-chart.tsx` (new), `share-of-voice.tsx`, tests/stories/e2e, changeset, 7 PNG screenshots.

## Rehearsal (2026-09-06 17:05–17:11Z, project `elmo-f07-rehearsal`, own config dir/network/volume, loopback 1516/5434, `SCRAPE_TARGETS=stub:stub`)

Dump `elmo-prod-pre-f07-rehearsal-20260906-170520.dump` (1,949,532 B, sha256 `f6e27b45…`, restored identical: runs 318, citations 931, journal 20). db-migrate exit 0, journal 20/20. Brand `arag`, Europe/Berlin, default window 2026-08-06…09-06 (32 d), 33 prompts: Top 6 WGV, HUK-COBURG, AUXILIA, ADAC, ÖRAG, ADVOCARD; tail DEURAG, ROLAND, DEVK.

| Date | ARAG | WGV | HUK-COBURG | AUXILIA | ADAC | ÖRAG | ADVOCARD | Others | Denominator | UI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 08-06 first | 15 → 37% | 8 → 20% | 8 → 20% | 3 → 7% | 1 → 2% | 1 → 2% | 1 → 2% | 4 → 10% | 41 | identical |
| 08-21 middle | 15 → 37% | 8 → 20% | 8 → 20% | 3 → 7% | 1 → 2% | 1 → 2% | 1 → 2% | 4 → 10% | 41 | identical |
| 09-06 last | 15 → 37% | 6 → 15% | 5 → 12% | 4 → 10% | 3 → 7% | 3 → 7% | 2 → 5% | 3 → 7% | 41 | identical |

model=chatgpt::premium identical to default (every production run is grounded); tags=rechtsschutz (16 prompts): first 25/20/10/20/5/5/5/10 of 20, last 23/18/14/14/14/9/5/5 of 22 — identical; lookback 1w via UI and after reload — identical. Headline 37% == brand cell == tooltip; competitor cells == tooltip; leaderboard tail DEURAG 2 + ROLAND 1 = 3/41 → 7% == Others. Exact shares sum to 100 (worst |Δ| 2.8e-14). 0 console/page errors, 0 failed requests. Rollback rehearsal PASS; project removed with `down -v` (that project only).

## Production acceptance (2026-09-06T17:48:51–17:49:14Z, read-only, brand `arag`, Europe/Berlin)

Independent oracle: SQL per-prompt/day brand and `unnest(competitors_mentioned)` counts (enabled prompts, tag semantics, grounded model rule) → whole-snapshot carry → last-day standings → Top 6 → Others → rounded once. Live data had moved since rehearsal (322 runs): last-day denominator 53, Top 6 WGV, HUK-COBURG, AUXILIA, **ÖRAG, ADAC**, ADVOCARD; tail DEURAG, ROLAND (DEVK earlier).

| Scope / date | Series | Oracle count | Denominator | Oracle % | UI % | Result |
|---|---|---:|---:|---:|---:|---|
| default 08-06 (first) | ARAG · WGV · HUK-COBURG · AUXILIA · ÖRAG · ADAC · ADVOCARD · Others | 15 · 8 · 8 · 3 · 1 · 1 · 1 · 4 | 41 | 37 · 20 · 20 · 7 · 2 · 2 · 2 · 10 | same | PASS |
| default 08-21 (middle) | same | 15 · 8 · 8 · 3 · 1 · 1 · 1 · 4 | 41 | 37 · 20 · 20 · 7 · 2 · 2 · 2 · 10 | same | PASS |
| default 09-06 (last) | same | 19 · 9 · 8 · 5 · 4 · 3 · 2 · 3 | 53 | 36 · 17 · 15 · 9 · 8 · 6 · 4 · 6 | same | PASS |
| model=chatgpt::premium first / last | same | as default | 41 / 53 | as default | same | PASS |
| tags=rechtsschutz first | ARAG · WGV · HUK-COBURG · AUXILIA · ÖRAG · ADAC · DEURAG · Others | 5 · 4 · 4 · 2 · 1 · 1 · 1 · 2 | 20 | 25 · 20 · 20 · 10 · 5 · 5 · 5 · 10 | same | PASS |
| tags=rechtsschutz last | same | 6 · 5 · 4 · 3 · 3 · 2 · 1 · 1 | 25 | 24 · 20 · 16 · 12 · 12 · 8 · 4 · 4 | same | PASS |
| lookback=1w (UI) first 08-31 / last 09-06 | as default | 41 / 53 | | as default | same | PASS |
| lookback=1w after reload, last | as default | | 53 | as default | same | PASS |

At every compared date: 8 active dots, 1 cursor, tooltip inside the viewport at the right edge, page overflow 0; exact shares sum to 100 in every scope. Cross-surface: headline **36%** == brand leaderboard cell **36%** == tooltip ARAG 36%; WGV 17 / HUK-COBURG 15 / AUXILIA 9 / ÖRAG 8 / ADAC 6 / ADVOCARD 4 == leaderboard cells; leaderboard tail DEURAG 2 + ROLAND 1 = 3 of 53 total mentions → 6% == tooltip Others. Legend order == tooltip order; Others dashed. Dark tooltip surface `oklch(0.141 0.005 285.823)`; 375 px legend 56 px below the plot, tooltip inside, overflow 0. Overview: 1 area, 0 line curves, no F-07 elements. Citations trend tooltip healthy ("August 25, 2026 Institutional 49% Editorial 35% …"). consoleErrors [] · pageErrors [] · failed same-origin requests []. Authentication side effect: one `session` row minted for the headless browser and deleted (count 1 → 1). Business data: prompt_runs 322 / citations 942 / enabled prompts 33, prompt_runs, citations and prompts digests identical before and after cutover and acceptance; scheduler 33 single pending chains, next job 2026-09-06T18:06:30Z unchanged; 0 provider calls. Screenshots `~/.elmo/f07-evidence/live/01…08.png`.

## Residual risks

| Risk | Owner | Follow-up |
|---|---|---|
| The Vitest Storybook project does not load the app's Tailwind plugin (only `.storybook/vite.config.ts` does), so class-sized layout is not applied in story tests; F-07 (like the F-06 Sankey) uses an explicit chart height and proves real-CSS layout in Playwright. Enabling `@tailwindcss/vite` there changes 4 existing story tests that rely on hidden mobile/desktop duplicates. | operator | separate small ticket: add the plugin and re-base those 4 stories |
| `phase1-flows` "unsaved-changes bar" test is timing-sensitive under 4 parallel local workers (passes alone and in CI with retries) | operator | observe; tighten if it recurs |
| Production currently has one tracked target, so the model selector is hidden on the page; the `?model=` deep link is still honoured (verified). | — | none |
