# UI-R1 Shared Metric Summary Pattern — production closeout

Status: **PASS / CLOSED** 2026-09-11. Supersedes the narrower "Shared BrandMetricLegend" ticket. Raw evidence (logs, measurements, screenshots): operator-private `~/.elmo/ui-r1-metric-summary-pattern-evidence/` (`cp0.md` + `cp0/baseline/`, `design-preview.md` + `design-preview/`, `cp3.md`, `images.md`, `rehearsal.md` + `rehearsal/`, `deploy-packet.md`, `cutover/`, `live/`). Recovery assets: `D:\ELMO-Recovery\UIR1-SharedMetricSummaryPattern-20260911\` (pre-cutover dump + sha256 + counts, `elmo-images-g039026ac.tar`, `aitrckr-uir1-2026-09-11.bundle`, `SHA256SUMS.txt`).

## Identities

| Item | Value |
|---|---|
| Starting baseline (CP0 = branch point) | `0cb292b3249d2b1b98d573e4cd2ce1979cd54057` (F-07R1 closeout; production source `a1991c2d`, images `ga1991c2d`); F-07R1 and F-08 PASS / CLOSED; no open PR; tracked tree clean |
| Gates | CP0 → `IMPLEMENTATION GO` → Storybook-only prototype + design preview → `DESIGN GO` (Variant B donut: shared 220 px stage, inner 59 / outer 103; approved Share of Voice tip; all other copy verbatim) → `PRODUCTION DEPLOYMENT GO` for exactly web `cb74417d25f3` / worker `12a1f1820e62` / db-migrate `568e841d8f8f` |
| Feature PR | [#34](https://github.com/e-orlov/aitrckr/pull/34), head `112a462f` (5 commits), required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit 5/5, mergeable CLEAN |
| Application source | `039026ac9a7d2850399edf09a35c4e75143bb15a` — squash merge of #34; post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check 4/4 success; feature branch deleted |
| Images (built once 2026-09-11T16:5x–17:10:57Z from the clean detached worktree at the source commit, isolated config dir `%USERPROFILE%\.elmo-build`, project `elmo-build`) | `elmo-web:g039026ac` `sha256:cb74417d25f3689a11eb25a2c90048ef97cef9f81df1902c252a0f94c7d2db15`; `elmo-worker:g039026ac` `sha256:12a1f1820e628a521df38f95c8cfa92f40bc7149e28b7f8c53bf3c80c0e8f92c`; `elmo-db-migrate:g039026ac` `sha256:568e841d8f8ffca06d88b2fa5eb87ab12a231178bd0ca5bc9d71f252abc85b55`; never rebuilt/re-tagged; the same IDs ran in rehearsal, rollback → redeploy and production. Web content verified (shared-shell slots, approved tip text, no Recharts legend). No OCI source/revision label (unchanged known limitation) |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, container not recreated (started 2026-09-08T23:00:29Z before and after) |
| Migration journal | 20 before and after (no migration; `git diff a1991c2d 039026ac` touches nothing under `packages/**`, `pnpm-lock.yaml`, any `package.json`, `apps/worker`, `apps/web/src/{server,hooks,lib}`, `docs/phase1/ops`) |
| Rollback target | `ga1991c2d` trio (web `b0eaed9fdb21`, worker `f987ce75d9fb`, db-migrate `3145f2aa8e1a`), on disk, untouched; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo ga1991c2d` + `docker compose up -d --no-build` (rehearsed both ways) |
| Backups | rehearsal `elmo-prod-pre-uir1-rehearsal-20260911-165335.dump` 2,884,406 B sha256 `e0a65e55…` (restored identically, 496 runs); pre-cutover `elmo-prod-pre-uir1-cutover-20260911-173156.dump` 2,884,696 B sha256 `c27c0aa4b1f5c64ff33452c757d0a0b7b6fee9ff89df9ed04fddfa49142d10fb`, restored in a disposable network-less pinned container with identical counts (brands 1 / prompts 33 / enabled 33 / competitors 12 / runs 496 / citations 1,436 / journal 20 / users 1 / sessions 1) and identical `prompt_runs` (`2e9de2e3…`), `citations` (`3b465d1d…`), `prompts` (`5b2d6848…`) digests |
| Pre-cutover revalidation (17:31Z) | `main == origin/main == 039026ac`; candidate and rollback IDs equal the packet; production on the exact `ga1991c2d` trio, restarts 0, postgres healthy, HTTP 200, `.env` `5155578153d44336`, `elmo.yaml` `07f423fe433c7ee6`, journal 20, ingestion healthy (33 runs today, 0 errors), 33 jobs `created`, next 20:57Z (≥ 3 h quiet window), C: 46 GB / D: 48 GB |
| Cutover | 2026-09-11T17:32:30.3Z `docker compose up -d --no-build` after `gen-prod-env.cjs … g039026ac` (`.env` byte-identical; `elmo.yaml` diff = exactly the three `image:` lines `ga1991c2d → g039026ac` + render timestamp, equal to the packet's expected diff; new `elmo.yaml` `f861651fd794265a`); db-migrate exit 0, journal 20, web HTTP 200 at 17:32:44.1Z (**≈14 s**) |
| Post-cutover state | web / worker / db-migrate on the exact candidate IDs, restarts 0; worker handlers registered; 33 `process-prompt` jobs `created`, schedule untouched (next 20:57:10Z) |
| Real-life acceptance | 2026-09-11T17:33–17:35Z read-only with the operator's existing session (signed in-process; never minted/deleted/refreshed — `session` count 1, `updated_at` 06:57:20Z unchanged) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- `apps/web/src/components/metric-summary/`: **`MetricSummaryCard`** (Card → `h2` title with an `About {title}` info tip using the shared tooltip primitive → headline value → full-width description → optional meta, omitted when absent → one visual group), **`MetricCardTitle`** (the same title/tip for sibling cards), **`MetricVisualGroup`** (chart left / legend right when the card content is ≥ 24 rem wide, chart centred with the legend below otherwise — a Tailwind 4 container query on the card, not the viewport; no dependency, no JS measurement), **`MetricLegend`** (semantic `ul/li`; exact caller order; display-ready `valueLabel`; optional emphasis and badge; decorative `aria-hidden` dot; label truncates with `title`; no tab stops; no Recharts). `README.md` is the integration note for the future Sentiment consumer.
- **Share of Voice** composes the shell from the unchanged `buildShareOfVoiceSlices` → `ShareOfVoiceDonutChart` (shared 220 px stage, inner 59 / outer 103, same sectors/tooltip) + `shareOfVoiceLegendItems`; the 8 rem text column, the far-right `sm:ml-auto` group and the hand-rendered list are removed; the card gains the info tip: "Each brand’s share of all brand and competitor mentions in the AI answers covered by the selected filters. Mentions are counted per run; displayed percentages may not total exactly 100% because each value is rounded independently."
- **AI Visibility** composes the same shell from `buildCompetitiveVisibilityRings` → `CompetitiveVisibilityRadialChart` + `competitiveVisibilityLegendItems`; the duplicated list and the private `TitleWithTip` are gone; existing copy verbatim.
- Unchanged: slice/ring construction, order and tie-breaks, Top-N, conditional `Others`, colours, tooltips, once-rounded values (Share of Voice 98–101 % displayed totals and AI Visibility totals above 100 % stay unnormalised), filters/URL/cache keys, request counts (one summary response per load on each page), trends, leaderboards. No data-plane, dependency or configuration change. **No Sentiment business logic** — only a Storybook-only synthetic category fixture.
- Fixed by design: the AI Visibility legend used to collapse to one-letter names at 1024 px (viewport `sm:` breakpoint vs a 343 px card); the group now stacks.

## Acceptance matrix

| ID | Criterion | Evidence | Status |
|---|---|---|---|
| UI-R1-01 | both cards use the shared shell | production: `share-of-voice-summary` and `competitive-visibility-summary` cards with `metric-summary-*` slots | PASS |
| UI-R1-02 | same title/info, spacing, typography, order, visual-group rules | live-verify: `h2` + `About …` on both; slot order value → group → chart → legend; identical tokens (CP0 computed styles) | PASS |
| UI-R1-03 | no 8 rem column / far-edge group | production text width 481 px in a 529 px content (was 128 px); donut below the summary, group left-aligned | PASS |
| UI-R1-04 | one generic `MetricLegend` for both lists | code; both lists are `MetricLegend` instances (`aria-label="Brands"`) | PASS |
| UI-R1-05 | exact order, preformatted values, no business logic | unit adapters (7), `metric-summary.stories.tsx` legend contract (order, ids, 0 %/100 %, duplicate labels, Unicode, no `%` appended) | PASS |
| UI-R1-06 | Share of Voice stays a donut with unchanged semantics | production F-07R1 driver PASS (list == sectors == leaderboard == headline, `Others` 6 %), F-07 oracle PASS (42 %, 16/16/6/6/3/3) | PASS |
| UI-R1-07 | AI Visibility stays radial with unchanged semantics | production F-08 driver PASS (5 scopes API == UI == oracle, 39 %, 496 runs) | PASS |
| UI-R1-08 | colours/entities agree with trend and leaderboard | F-07R1 + F-08 drivers; rehearsal frozen-data legend values identical across `ga1991c2d`/`g039026ac` | PASS |
| UI-R1-09 | unnormalised totals | unit/stories (99 %, 101 %, Σ > 100 %); production Σ 98 % (42+16+16+6+6+3+3+6) | PASS |
| UI-R1-10 | desktop/tablet/mobile/dark without clipping/overflow | live-verify 14/14 readings (1400/1280/1024/768/375 light; 1400/375 dark): overflow 0, row at ≥ 384 px content, column at 341 px | PASS |
| UI-R1-11 | long labels and `You`/value columns readable | production names fit at every width; long/Unicode stories | PASS |
| UI-R1-12 | no Recharts `Legend` | `.recharts-legend-wrapper` 0 in both cards (stories, E2E, production) | PASS |
| UI-R1-13 | zero data-plane change | structural diff; journal 20 → 20; `.env` byte-identical; business digests before == after | PASS |
| UI-R1-14 | request counts, filters, states, tooltips, trends, leaderboards | 1 summary response per load on each page; F-07/F-07R1/F-08 drivers in 5 scopes; donut tooltip `ARAG: 42%` | PASS |
| UI-R1-15 | synthetic category story proves the contract | `metric-summary.stories.tsx` "Synthetic category metric" (+ narrow/dark/meta variant); README example | PASS |
| UI-R1-16 | design preview approved before integration | `design-preview.md`; DESIGN GO received before commit `9e7c52b9` | PASS |
| UI-R1-17 | all gates on exact artifacts | below | PASS |

## Verification

| Check / command | Exit | Result |
|---|---:|---|
| `pnpm lint` (726 files) | 0 | 0 errors |
| `pnpm -r --if-present check-types` | 0 | ✓ |
| `pnpm test` | 0 | 13/13 tasks; web 528 (+7) |
| `pnpm -C apps/web test:storybook` | 0 | 161/161 (+10) |
| `pnpm test:scripts` | 0 | 30/30 |
| `pnpm build` + `check-server-bundle.mjs` | 0 | 16/16; exit 0 |
| `pnpm license-check` | 0 | compliant |
| Playwright `local` new spec + touched specs (rebuilt test stack) | 0 | metric-summary-pattern 4/4, share-of-voice-brand-list 4/4, competitive-visibility 6/6, share-of-voice-trends 7/7 |
| Playwright `local` full (4 workers) | 1 | 104 passed / 2 worker-gated skips / 2 failed (`organization-rename`, `bulk-prompt-tags` — settings/editor flows timing out under load; **8/8 pass in isolation**, unrelated) |
| PR #34 required checks; post-merge `main` | — | 5/5; 4/4 |
| Rehearsal (`g039026ac` on the restored dump) | 0 | UI-R1 live-verify 14/14 ×2, F-07R1 PASS, F-08 PASS, F-07 oracle PASS |
| Rollback rehearsal (`g039026ac` → `ga1991c2d` → `g039026ac`) | 0 | old UI back (its only failing reading = the pre-existing 1024 px collapse), candidate back, journal 20 each time, frozen-data values identical |
| Production live-verify (`127.0.0.1:1515`, existing session) | 0 | UI-R1 14/14, F-07R1 PASS, F-08 PASS, F-07 PASS, 0 console/page/failed requests |

## Production acceptance (2026-09-11T17:33–17:35Z, brand `arag`, Europe/Berlin)

| Card | 1400 | 1280 | 1024 | 768 | 375 | dark 1400 / 375 |
|---|---|---|---|---|---|---|
| Share of Voice (8 rows: ARAG You 42, HUK-COBURG 16, WGV 16, AUXILIA 6, ÖRAG 6, ADAC 3, ADVOCARD 3, Others 6 — Σ 98 %) | row, 529×396, text 481 | row, 469×396 | column, 341×564 | row, 452×396 | column, 341×560 | ✓ |
| AI Visibility (7 rows: ARAG You 39, HUK-COBURG 15, WGV 15, AUXILIA 6, ÖRAG 6, ADAC 3, ADVOCARD 3) | row, 529×452, text 481 | row, 469×452 | column, 341×620 | row, 452×452 | column, 341×616 | ✓ |

Every reading: one `h2`, `About …` button, slot order, text full width, chart below text, rows == chart entities, no cross chart type, correct row/column by card width with the expected geometry, names readable, values inside the legend, page/card overflow 0, no `.recharts-legend-wrapper`, no tab stops, exactly one `You`, one summary server response. Tips verbatim (approved Share of Voice text; unchanged AI Visibility text). consoleErrors [] · pageErrors [] · failedRequests [] (web log: two `Error: aborted` pairs at 17:34:26Z = headless navigation mid-request, test artifact). Business data before == after (`prompt_runs` `2e9de2e3…`, `citations` `3b465d1d…`, `prompts` `5b2d6848…`; session 1 / `updated_at` unchanged). Screenshots `~/.elmo/ui-r1-metric-summary-pattern-evidence/live/ui-r1/`; before/after PR screenshots in `docs/governance/ui-r1-shared-metric-summary-pattern/`.

Natural ingestion: the scheduler was not touched (33 jobs `created`, next cycle 20:57:10Z); the result of that first natural cycle on the new worker is recorded in the operator-private evidence and the release addendum.

## Residual risks

| Risk | Owner | Follow-up |
|---|---|---|
| Summary cards are taller on desktop (Share of Voice 320 → 396 px at 1400 px) — approved hierarchy, no clipping | — | none |
| Long entity names truncate (full text in `title`/DOM), as before | — | documented |
| Images carry no OCI source/revision label | operator | unchanged small ticket |
| OpenRouter per-key limit still cumulative (no reset) | operator | clear it or set a monthly reset |
| Sentiment must consume `MetricSummaryCard`/`MetricLegend` per `metric-summary/README.md`; no Sentiment logic exists yet | — | future ticket |
