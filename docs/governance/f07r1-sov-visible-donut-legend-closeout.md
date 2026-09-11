# F-07R1 Share of Voice Visible Donut Legend Harmonization — production closeout

Status: **PASS / CLOSED** 2026-09-11. Corrective follow-up to F-07 (found by comparing the finished F-07 and F-08 layouts); F-08 was not reopened. Raw evidence (logs, results, screenshots): operator-private `~/.elmo/f07r1-evidence/` (`cp0.md`, `design.md`, `cp3.md`, `images.md`, `rehearsal.md`, `deploy-packet.md`, `cutover/`, `live/`, `rehearsal/`, `e2e-shots/`). Recovery assets: `D:\ELMO-Recovery\F07R1-SovVisibleDonutLegend-20260911\` (pre-cutover dump + sha256 + counts, `elmo-images-ga1991c2d.tar`, `aitrckr-f07r1-2026-09-11.bundle`, `SHA256SUMS.txt`).

## Identities

| Item | Value |
|---|---|
| Starting baseline (CP0 = branch point, `main` = `origin/main`) | `c1e0112fca23def583fa77146e8cd91366cd94c4` (F-08 closeout + OpenRouter-resolution docs; application source of the running images `909e8d86`, docs-only delta re-verified before branching); F-04, F-06, F-07, F-08 CLOSED; no open PR; tracked tree clean |
| Feature PR | [#32](https://github.com/e-orlov/aitrckr/pull/32), head `a94eec7e` (4 commits), required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit 5/5 on the latest commit, mergeable CLEAN |
| Application source | `a1991c2d2acbcc61a81250969e4ed3fb2f79757a` — squash merge of #32 (tree `b8b8719c…` identical to the branch head); post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check 4/4 success; feature branch deleted locally and remotely |
| Images (built once 2026-09-11T11:28–11:31Z from the clean detached worktree at the source commit, isolated config dir `%USERPROFILE%\.elmo-build`, project `elmo-build`) | `elmo-web:ga1991c2d` `sha256:b0eaed9fdb21a152a7065b835962d881f7fdf47250ee996c1ebbd5bb351e3187`; `elmo-worker:ga1991c2d` `sha256:f987ce75d9fb91f6c2d073f87d51b63cd47dc8e4de0b547febe3d85f98208a8b`; `elmo-db-migrate:ga1991c2d` `sha256:3145f2aa8e1acb5140f1cc68e675f6f8130a65adf131e60ffe903f2a6936ae2e`; never rebuilt or re-tagged; the same IDs ran in rehearsal, rollback→redeploy and production. The web image's layers were all cache hits from the branch-identical test build (content verified: client chunk carries `share-of-voice-brand-list`, `max-w-[8.5rem]`, `sm:max-w-[8rem]`, no `recharts-legend`). No OCI source/revision label (unchanged known limitation) |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, volume `elmo_postgres_data`, container not recreated (started 2026-09-08T23:00:29Z before and after) |
| Migration journal | 20 before and after (no migration: `git diff 909e8d86 a1991c2d` touches nothing under `packages/lib/src/db`, no `package.json`/lockfile, no server/hook/query/ops file) |
| Rollback target | `g909e8d86` trio (web `72e64000d0aa`, worker `f79d5766deeb`, db-migrate `e61b00874621`), present locally, not rebuilt/retagged/pruned; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo g909e8d86` + `docker compose up -d --no-build` (rehearsed both ways: previous UI back, then candidate back with identical IDs, journal 20 each time) |
| Backups | rehearsal `elmo-prod-pre-f07r1-rehearsal-20260911-112925.dump` 2,744,662 B sha256 `1e8015e8…` (restored identically: 468 runs, journal 20); pre-cutover `elmo-prod-pre-f07r1-cutover-20260911-124301.dump` 2,756,228 B sha256 `7509c5537647a225689087ec1b4346e8578d8fe892a5b49298006508cf7a5a62`, restored in a disposable network-less pinned container with identical counts (brands 1 / prompts 33 / enabled 33 / competitors 12 / runs 471 / citations 1,356 / journal 20 / users 1 / sessions 1) and identical `prompt_runs` (`f1a232c2…`), `citations` (`c87cfdc1…`), `prompts` (`5b2d6848…`) digests |
| Explicit approvals | IMPLEMENTATION GO (CP0 accepted PASS), then PRODUCTION DEPLOYMENT GO for exactly web `b0eaed9fdb21` / worker `f987ce75d9fb` / db-migrate `3145f2aa8e1a` per the deploy packet, with the documented responsive behaviour and list ordering explicitly accepted |
| Pre-cutover revalidation (12:42Z) | `origin/main == main == a1991c2d`; candidate and rollback image IDs equal the packet; production on the exact `g909e8d86` trio, restarts 0, postgres healthy, HTTP 200, `.env` `5155578153d44336`, `elmo.yaml` `31a6543b6257265d`, journal 20/20, ingestion healthy (8 runs today, 0 errors), 33 jobs `created`, next 13:02Z (≥ 18 min quiet window), C: 46 GB / D: 50 GB free |
| Cutover | 2026-09-11T12:43:41.7Z `docker compose up -d --no-build` (project `elmo`, `elmo.yaml` + `prod-env.override.yaml`) after `gen-prod-env.cjs … ga1991c2d` (`.env` byte-identical; `elmo.yaml` diff = exactly the three `image:` lines `g909e8d86 → ga1991c2d` + render timestamp, equal to the packet's expected diff); db-migrate exit 0 ("migrations applied successfully"), journal 20, web HTTP 200 at 12:43:54.6Z (**≈13 s**); postgres untouched |
| Post-cutover state | web / worker / db-migrate on the exact candidate IDs, restarts 0, `.env` hash unchanged, `elmo.yaml` `07f423fe433c7ee6`; web log 1 line / worker log 11 lines, 0 errors; 33 `process-prompt` jobs `created`, schedule untouched |
| Real-life acceptance | 2026-09-11T12:44:28–12:46:38Z read-only against the production UI with the operator's existing session (signed in-process; no session minted, deleted or refreshed — `session` count 1, `updated_at` 06:57:20Z unchanged) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- The **Share of Voice** summary card keeps its title, headline, subtitle and segmented donut, and now shows a permanently visible list beside the donut: one row per rendered sector — colour dot, full entity name, the `You` badge for the own brand, right-aligned share — in the AI Visibility legend's markup and tokens (`ul[aria-label=Brands]`, `text-xs`, `grid gap-1`, `h-3`/`h-2.5` dots, `font-medium` brand / `text-muted-foreground` competitors, `font-mono tabular-nums`).
- One canonical slice array (`buildShareOfVoiceSlices`: brand → first six competitors in the server's order → `Others` only when a tail exists; `kind: brand | competitor | others`; `percent = round(mentions / total × 100)` computed once) drives the sectors, the tooltip and the list. `Others` keeps the grey, never carries `You`, never exposes hidden-tail names. Displayed integers are independently rounded and **not** renormalised (production today: 37/15/13/11/7/7/4 + Others 7 = 101 %).
- Ordering follows the donut/leaderboard rank: the brand appears first whenever it leads (production) and otherwise at its rank with `You` — accepted; `Others` is last when present.
- Layout: ≥ `sm` the summary (≤ 8 rem) sits left and the `donut → list` group right, vertically centred, card height unchanged (320 px at 1400 px); when a half-width card is too narrow for the row (viewport ≲ 1320 px) the group wraps under the summary without squeezing names (1280 px: card 392 px, names fit, overflow 0); below `sm` summary → donut (centred) → list stack, page overflow 0 at 375 px. Long names truncate with the full name in `title`/DOM text.
- No formula, denominator, mention count, Top-6 selection, tie-break, Others aggregation, rounding, filter, URL, API, SQL, cache key, leaderboard, trend, donut sector/tooltip, AI Visibility, schema or dependency change. The donut gained an explicit `size` prop (default 180) so stories can measure it.

## Requirement traceability

| Requirement | Evidence | Status |
|---|---|---|
| F07R1-FR-001 donut retained | production: 1 `.recharts-pie`, 8 sectors, tooltip `ARAG: 37%` on hover | PASS |
| F07R1-FR-002 permanently visible list | production: list visible on load without hover in 5 scopes | PASS |
| F07R1-FR-003 membership == sectors | unit; stories; E2E; production: 8 rows == 8 sectors (default), 8/8 (tag scope) | PASS |
| F07R1-FR-004 canonical order | unit (server order, tie fold, brand-not-leading); E2E tie at the Top-6 boundary (Golf → Others); production rows == leaderboard rank | PASS |
| F07R1-FR-005 colour · name · % | production: dot rgb == sector fill == palette by position for every row | PASS |
| F07R1-FR-006 `You` on brand only | production: `You` only on ARAG in all scopes | PASS |
| F07R1-FR-007 Others last, conditional, grey | E2E `model=claude` (no tail → no Others); production Others last, `#cbd5e1`, 3/46 → 7 % | PASS |
| F07R1-FR-008 values reconcile | production: list == leaderboard Share cells == trend legend/strokes == F-07 independent oracle (headline 37 % == brand row; Others == oracle tail 7 %) in 5 scopes | PASS |
| F07R1-FR-009 filters atomic | production model / tag / 1w / 1m scopes: donut, list, leaderboard, trend re-render from one response (1 Share of Voice server call per load, 21.4 KB / 58–258 ms) | PASS |
| F07R1-FR-010 AI Visibility unchanged | no `competitive-visibility/*` file changed; production section: 0 pies, 0 brand lists, radial legend 7 rows with `You`; rehearsal frozen-data comparison identical across `g909e8d86`/`ga1991c2d` | PASS |
| NFR-001/002/003/004 no migration / dependency / metric-query change / provider call | structural zero-diff; journal 20 → 20; worker log 0 provider lines | PASS |
| NFR-005 375 px overflow 0 | production overflow 0, stacked, donut centred, `%` cells inside viewport; 640 px E2E | PASS |
| NFR-006 light/dark | production dark: dots keep entity colours, text `oklch(0.985 0 0)` / `oklch(0.705 0.015 286.067)` | PASS |
| NFR-007 a11y | `ul[aria-label=Brands]`, dots `aria-hidden`, `title` == name, no `button/a/[tabindex]`, `Others` readable | PASS |
| NFR-008 no payload/perf regression | same server response (21,446 B) as `g909e8d86`; no extra request | PASS |
| NFR-009 F-07 trends/leaderboard + F-08 intact | F-07 oracle PASS in production; F-08 checks above; Overview/Citations smoke | PASS |
| NFR-010 exact rehearsed artifacts | image IDs identical in build record, rehearsal, rollback→redeploy and production | PASS |

## Verification

| Check / command | Exit | Result |
|---|---:|---|
| `pnpm lint` (721 files) | 0 | 0 errors |
| `pnpm -r --if-present check-types` | 0 | ✓ |
| `pnpm test` | 0 | 13/13 tasks; web 521 (+10 unit) |
| `pnpm -C apps/web test:storybook` | 0 | 151/151 (+10 donut stories) |
| `pnpm test:scripts` | 0 | 30/30 |
| `pnpm build` + `check-server-bundle.mjs` | 0 | 16/16; client `share-of-voice-*.js` has no database strings |
| `pnpm license-check` | 0 | compliant |
| Playwright `local` new spec (rebuilt `aitrckr-test` stack) | 0 | 5/5 |
| Playwright `local` full | 0 | 104 passed / 2 worker-gated skips / 0 failed (after fixing the F-07 spec's `hoverAt` to centre the plot — the stacked 375 px card pushes it off-screen) |
| PR #32 required checks; post-merge `main` workflows | — | 5/5; 4/4 |
| Rehearsal live-verify (`e2e/f07r1-live-verify.local.mts`, restored dump, `ga1991c2d`) | 0 | PASS ×2 (5 scopes, composition, tooltip, 375 px, dark, F-08, 5/5 single calls, 0 errors) |
| F-07 independent oracle on the candidate (rehearsal) and in production | 0 | PASS / PASS |
| Rollback rehearsal (`ga1991c2d` → `g909e8d86` → `ga1991c2d`) | 0 | previous UI back (no list), candidate back, identical IDs, journal 20 each time; frozen-data SoV and F-08 values identical across images |
| Production live-verify (`127.0.0.1:1515`, existing session) | 0 | PASS — 5 scopes, 1400/1280/375 px, dark, tooltip, F-08, Overview/Citations, 0 console/page/failed requests |

## Production acceptance (2026-09-11T12:44–12:46Z, read-only, brand `arag`, Europe/Berlin, existing operator session)

| Scope | Rendered list (name → %) | Σ shown | Others | Headline |
|---|---|---:|---:|---|
| default 1m | ARAG 37 (You), WGV 15, HUK-COBURG 13, ADAC 11, AUXILIA 7, ÖRAG 7, ADVOCARD 4, Others 7 | **101 %** | 3/46 → 7 | 37 % |
| model=chatgpt::premium | same | 101 % | 7 | 37 % |
| tags=rechtsschutz | ARAG 26, WGV 19, HUK-COBURG 15, ADAC 11, AUXILIA 11, ÖRAG 11, Allianz 4, Others 4 | 101 % | 4 | 26 % |
| lookback 1w | as default | 101 % | 7 | 37 % |
| default 1m again | as default | 101 % | 7 | 37 % |

Leaderboard (default): ARAG 17 (37 %) · WGV 7 (15 %) · HUK-COBURG 6 (13 %) · ADAC 5 (11 %) · AUXILIA 3 (7 %) · ÖRAG 3 (7 %) · ADVOCARD 2 (4 %) · Allianz 1 (2 %) · DEURAG 1 (2 %) · R+V 1 (2 %) — total 46; the list's `Others` 7 % = the tail 3/46 (the tail rows stay individual in the table). Trend legend roster and strokes == list names and colours. F-07 oracle: every tooltip row == SQL/JS oracle at first/middle/last dates, headline 37 % == brand cell. Composition 1400 px: list right of donut, donut right of summary, centred, card 320 px; 1280 px: group wraps under the summary, names fit, card 392 px, overflow 0; 375 px: stacked, donut centred, overflow 0. Dark theme ✓. AI Visibility: 0 pies, 0 brand lists, radial legend `ARAG You 41%, WGV 17%, HUK-COBURG 15%, ADAC 12%, AUXILIA 7%, ÖRAG 7%, ADVOCARD 5%`. consoleErrors [] · pageErrors [] · failedRequests [] (the web log's two `Error: aborted` pairs at 12:44:45Z are the headless browser navigating away mid-request — test artifact). Business data before == after (`prompt_runs` `f1a232c2…`, `citations` `c87cfdc1…`, `prompts` `5b2d6848…`, session 1 / `updated_at` unchanged). Screenshots `~/.elmo/f07r1-evidence/live/`; before/after PR screenshots in `docs/governance/f07r1-sov-visible-donut-legend/`.

## Residual risks

| Risk | Owner | Follow-up |
|---|---|---|
| Half-width card narrower than ≈ 430 px content (viewport ≲ 1320 px): the group wraps under the summary and the card grows ≈ 70–90 px | — | accepted behaviour |
| Very long entity names truncate (full name in `title` and DOM text), as in the AI Visibility legend | — | documented |
| Brand not leading the standings is shown at its rank with `You` (mirrors donut and leaderboard) | — | accepted behaviour, pinned by unit test |
| Images carry no OCI source/revision label | operator | unchanged small ticket |
| OpenRouter per-key limit is still cumulative (no reset) | operator | clear it or set a monthly reset |
