# F-06 Owned Citation URL Structure (Sankey) — production closeout

Status: **PASS / CLOSED** 2026-09-06. Corrected by `f06-owned-citation-structure-closeout-r1.md` (Corrective R1): the config-regeneration claim in the manifest, the two Windows-only test exceptions and the "no data written" wording below are superseded there; this file is kept as the historical record referenced by the original immutable tag. Sanitized evidence for recovery and audit; raw logs, dumps and screenshots live outside Git under the operator's private `.elmo` evidence and backup directories (`~/.elmo/f06-evidence/`, `D:\ELMO-Recovery\F06-OwnedCitationStructure-20260906\`).

## Identities

| Item | Value |
|---|---|
| Planning baseline | `33c94cd175f9b128cfd03901ff04ab51fc189f45` (audit of 2026-09-04) — context only |
| Starting baseline (main = origin/main) | `e599fc689627428da3367e1df43b9c85b59bb8ec` (F-04 R2 closeout docs); production source `4f30f53e7c25cace166ab704dab08365a0458888`, images `g4f30f53e` (web `2ae5f5cb013f`, worker `01191f72864d`, db-migrate `244e60d21d24`), diff `4f30f53e..e599fc68` = 3 docs files only; F-04 formally CLOSED (backlog, closeout, tag `production/f04-bulk-prompt-tags-r2-2026-09-06`) |
| Feature PR | [#21](https://github.com/e-orlov/aitrckr/pull/21), head `065b4d25`, required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit all success |
| Application source (`F06_FEATURE_MERGE_SHA`) | `48e697837045c585ffaf32d821dcf601f841ab5d` — squash merge of #21; post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check all success |
| Images (built once 2026-09-06T10:42–11:00Z from a clean detached worktree at the source commit, isolated config dir, project `elmo-f06-build`) | `elmo-web:g48e69783` `sha256:6891e26bc69f44b24978e552e22365384613a96f1d0b61ae55d10275deca766c`; `elmo-worker:g48e69783` `sha256:8842d34fe941fb18c0bbf5168d80f77b3635f922eed77390fa3227e02e6c0459`; `elmo-db-migrate:g48e69783` `sha256:167d86d1c39beb54fa50fe7a7a625a6ee7a2c6235e70b9c091a0a46264c1a07f` (linux/amd64; the web image carries the `citation-structure-*.js` route chunk, the previous one does not) |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, volume `elmo_postgres_data`, container not recreated by the cutover |
| Migration journal | 20 before and after (F-06 has no migration; `packages/lib/src/db/migrations` identical between `4f30f53e` and `48e69783`) |
| Rollback target | `g4f30f53e` trio above, present locally; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo g4f30f53e` + `docker compose up -d --no-build` (rehearsed on the restored copy: Citations total 927, no new sidebar item, `/citation-structure` falls to the layout's not-found view) |
| Pre-deploy backup | `elmo-prod-pre-f06-cutover-20260906-110949.dump` 1,935,046 B sha256 `382de205f4879318e0c80f90f5ac7b9c74d93c25b63de54858787e5747e3b3f8`, TOC 197, restored in a disposable container with identical counts (brands 1 / prompts 33 / enabled 33 / runs 317 / citations 927 / journal 20 / users 1) and digests (citations `8ba398fd…`, arag prompts `fc19ab03…`) |
| Cutover | 2026-09-06T11:12:27Z `docker compose up -d --no-build` (project `elmo`), db-migrate exit 0, web HTTP 200 at 11:12:39Z (≈12 s), 17 config keys hash-equal before/after regeneration, timed between two scheduled prompt jobs (11:11Z done, next 17:11Z) |
| Real-life acceptance | 2026-09-06T11:12:55–11:13:07Z read-only oracle run against the production UI (below) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- Sidebar item **Citation Structure** (`IconChartSankey`) between **Citations** and **Opportunities**, shown under the same `brand.onboarded` condition; route `/app/org/$org/brand/$brand/citation-structure`, crumb/title "Citation Structure", exact active state (longest-prefix rule; `citations` and `citation-structure` never light each other).
- The page is the title, the shared model/tags/lookback filter row and exactly one Sankey. Loading skeleton, error + Retry, truly-empty, filtered-no-match (Clear filters) and "no owned domain configured" states replace the diagram; no KPI cards, tables, tabs, lists, second chart or search.
- Hierarchy brand → configured owned domain → raw hostname → normalized path; flow unit = one `citations` row (`count(*)` of the raw-URL group is added as-is). Owned = `extractDomain(website)` ∪ `extractDomain(additionalDomains)`, exact-or-dot-suffix, longest configured candidate wins; lookalike suffixes excluded; no supplemental-classification input. Hostname from the raw stored URL (WHATWG `URL`, http/https only, lowercased, `www.`/subdomains preserved, port ignored); path = `pathname`, empty → `/`, non-root trailing slashes stripped, case/internal `//`/parser percent-encoding preserved, query/fragment/scheme/port/userinfo excluded.
- Display reduction with conserved values: top 8 domains → **Other owned domains → Other hosts → Rest**; top 6 hosts per domain → **Other hosts → Rest**; one reserved top path per visible host, then a global budget of 60 paths → per-host **Rest**; order count desc, key asc (locale-independent), synthetic last; synthetic tooltips state "N occurrences across M …". `assertConservation` guards every result (root = Σ nodes per depth = Σ links per depth, inflow = value = outflow, positive integers, unique ids).
- Server function `getCitationStructureFn`: zod → `requireAuthSession` → `requireBrandAccess` → same UTC window, enabled prompts, tag and model semantics as Citations (`promptIdsMatchingTags`/`availableTagsFor`/`parseTagFilter` lifted verbatim into `citation-filters.ts`; `citations.ts` imports them, behavior unchanged) → existing `getCitationUrlStats` → builder. Payload: available tags, owned-domain count, totals, nodes, links. Invalid URLs counted in `excludedInvalidUrlOccurrences` and logged as an aggregate only. The read path lives in `citation-structure-load.ts` so no database import reaches the client bundle.
- Sankey (Recharts 3.10.1, already installed): theme-paired colours per level via the chart's CSS variables (light/dark), custom nodes with label + count + `<title>`, subdued target-coloured links, tooltip with full label / kind / exact count / share / hidden-child count, visually hidden hierarchical summary for assistive technology, `role="application"` accessibility layer, deterministic height (26 px per terminal, 360–3600), minimum canvas width 880 px with horizontal scrolling on narrow viewports, no animation.

## Requirement traceability

| AC | Evidence | Status |
|---|---|---|
| AC-01 dedicated item after Citations | `app-sidebar.stories` DashboardOrder + OnboardingHidesCitationStructure; E2E rail order and onboarded gate; production rail `Citations → Citation Structure → Opportunities` | PASS |
| AC-02 route and active state | `nav-active.test` prefix case; E2E `data-active` true/false and title; production `activeOk: true`, title "Citation Structure \| ARAG · Elmo" | PASS |
| AC-03 only the Sankey | stories `expectOnlyTheSankey` (1 chart, 0 tables/tabs/cards/search); E2E DOM counts; production 1 chart / 0 tables / 0 cards | PASS |
| AC-04 hierarchy | UT-01/05–08; E2E node kinds; production nodes brand/domain/host/path | PASS |
| AC-05 occurrence metric | UT-02/03/23; server test feeding raw url + count; E2E and production `count(*)` oracles | PASS |
| AC-06 conservation | `assertConservation` + UT-22; E2E per-depth sums; rehearsal and production oracle tables below | PASS |
| AC-07 raw host distinction | UT-05/06; E2E www/apex/prerelease/h1..h7; production shows the only hosts present (`www.arag.de`, `www.arag.com`) with SQL-equal counts | PASS |
| AC-08 longest suffix, lookalikes | UT-07–09; E2E `notarag.de` / `arag.de.evil.test` never shown | PASS |
| AC-09 path identity | UT-04/11–13; E2E `/service` merges `/service/`, `?utm`, `#faq` | PASS |
| AC-10 filters | `citation-filters.test`, server semantics tests; E2E model 8/9, tags 6/11, lookback 15/17 vs oracle; production model/tag/lookback/reload vs oracle | PASS |
| AC-11 deterministic Rest/Other | UT-16–21; RestReduction story; E2E Other hosts/Rest 4 across 4 hostnames | PASS |
| AC-12 accessibility / responsive / theme | `role=application`, sr summary, Dark/Narrow/LongLabels stories; E2E dark fill + 375 px scroll canvas; production dark + narrow screenshots | PASS |
| AC-13 malformed URLs | UT-10; server excluded count; aggregate-only warn log | PASS |
| AC-14 authorization | server tests: unauthenticated and foreign-brand requests refused before any read | PASS |
| AC-15 zero migration / dependency / LLM / fetch / write | diff (no migrations, lockfile or `package.json` change), call-path review, CI | PASS |
| AC-16 no regressions | unit lib 633 / web 433 / config 93 / cloud 43 / cli 28; Storybook 122 (+ pre-existing Windows-locale `cloud-billing` story); Playwright `local` 88 passed / 2 worker-gated skips; production Citations page total 931 renders; scheduler 33 prompts → 33 single chains, 0 duplicates after cutover | PASS |
| AC-17 lifecycle | PR #21 checks → post-merge main green → immutable trio → rehearsal → verified backup → deploy → production acceptance → this closeout, tag and release | PASS |

## Verification summary

Local (branch, Windows VM): lint 0 (701 files); check-types 13/13; unit as above (+46 new); Storybook `citation-structure` 11/11, `app-sidebar` 13/13; scripts 11/12 (pre-existing `check-server-bundle.test.mjs` Windows path case; `check-server-bundle.mjs apps/web` rc 0); build with regenerated `routeTree.gen.ts`, tree clean; license check 1,260 packages compliant; client-bundle scan free of database code. Test stack `aitrckr-test` rebuilt from the branch: F-06 spec 6/6, full `local` project 88 passed / 2 skipped.

Rehearsal (`elmo-f06-rehearsal`, own config dir/volume/network, web 127.0.0.1:1516, pg 127.0.0.1:5434, fresh secrets, placeholder provider key, stub worker): dump `elmo-prod-pre-f06-rehearsal-20260906-110156.dump` (1,934,920 B, sha256 `aaa5b4dc…be8249`, TOC 197) restored with identical counts and digest; candidate boot, db-migrate exit 0, journal 20; oracle table below; `EXPLAIN (ANALYZE, BUFFERS)` of the existing grouped citation query on the copy: `citations_prompt_id_created_at_idx` bitmap scans, 927 rows → 270 groups, planning 3.3 ms, execution 6.8 ms — no new index; server function 14–16 ms, payload 2,284 B, click-to-diagram 419 ms; console/page errors 0, failed same-origin requests 0; narrow canvas 880 > 343; rollback to `g4f30f53e` and back; project removed with `down -v` (that project only). Incident: regenerating the rehearsal config resets non-secret keys, so the rollback worker ran ≈40 s with the real target string and the placeholder key before being stopped and re-stubbed — 0 provider or error lines, no job due; production regeneration was verified key-by-key instead.

### Count reconciliation

| Scope | SQL owned occurrences | root | domain-link sum | host-link sum | terminal-link sum | Result |
|---|---:|---:|---:|---:|---:|---|
| Rehearsal · arag · default 1m (of 927) | 81 | 81 | 81 | 81 | 81 | PASS |
| Rehearsal · model chatgpt::premium | 81 | 81 | 81 | 81 | 81 | PASS |
| Rehearsal · tag rechtsschutz (of 445) | 7 | 7 | 7 | 7 | 7 | PASS |
| Rehearsal · lookback 1w | 81 | 81 | 81 | 81 | 81 | PASS |
| Rehearsal · reload ?lookback=1m&model=chatgpt::premium | 81 | 81 | 81 | 81 | 81 | PASS |
| Production · arag · default 1m (of 931) | 81 | 81 | 81 | 81 | 81 | PASS |
| Production · model chatgpt::premium | 81 | 81 | 81 | 81 | 81 | PASS |
| Production · tag rechtsschutz (of 449) | 7 | 7 | 7 | 7 | 7 | PASS |
| Production · lookback 1w | 81 | 81 | 81 | 81 | 81 | PASS |
| Production · reload ?lookback=1m&model=chatgpt::premium | 81 | 81 | 81 | 81 | 81 | PASS |

Hostnames (both environments): SQL `www.arag.de` 58, `www.arag.com` 23 = diagram. 27 nodes (1 brand, 2 owned domains, 2 hostnames, 22 paths; no folding needed at this size). Inspected path nodes, e.g. `www.arag.de/rechtsschutzversicherung/mietrechtsschutz-sofort` 14, `www.arag.de/rechtsschutzversicherung` 9, `www.arag.com/de/trendmonitor-recht` 11. Tooltip on `www.arag.de`: "Hostname · 58 occurrences · 71,6% of owned citations". `?model=chatgpt` (standard, non-grounded) shows the filtered-no-match state in both environments, exactly like the Citations page: every production run is grounded through the openrouter API provider and belongs to `chatgpt::premium`.

### Production live test (metadata only)

Operator-authorized read-only run at 2026-09-06T11:12:55Z: one session row for the operator's account was minted for the headless browser and deleted afterwards (`session` count back to 1); DB reads via `docker exec psql`; no data written. Sidebar → Citation Structure: order and active state correct, 1 chart / 0 tables / 0 cards, click-to-diagram 1,097 ms (cold), server function 110–117 ms, payload 2,284 B; deep link + reload keeps the filter; dark and 375 px layouts captured; existing Citations page loads with "Total Citations 931"; console errors 0, page errors 0, failed same-origin requests 0. Web log after cutover: only two `Error: aborted / ECONNRESET` lines at 11:13:01Z, i.e. requests the test browser abandoned when navigating to the next filter (the same lines appear on the test stack after every Playwright run); worker log 0 errors; 33 enabled prompts → 33 single pending chains, 0 duplicates; arag prompts digest `fc19ab03…` unchanged.

## Residual risks

- Production currently has only `www.*` hostnames, so the apex/subdomain distinction is proven by unit, Storybook and E2E fixtures rather than by production data. Owner: operator; follow-up: re-run `f06-live-verify` when a non-`www` owned host appears.
- Theme: the app has no dark-mode toggle; dark compatibility is verified through the `.dark` class (as Storybook and the live driver do). Owner: product; no action unless a toggle ships.
- Keyboard focus reaches the chart as one `application` region; individual nodes are exposed through the hidden hierarchical summary, not as focusable elements (Recharts limitation). Owner: product; revisit if Recharts adds per-node focus.
- Charts with the maximum folded shape (≈120 terminal nodes) are up to 3,600 px tall and rely on page scrolling; verified in the RestReduction story, not observed in production data. Owner: product.

## Attestations

No direct push, bypass or history rewrite; no migration/schema/dependency/lockfile/secret change; no LLM or provider call, external URL fetch or citation write introduced; no live provider call in tests or rehearsal; no Docker reset/prune/relocation; production volume untouched; `down -v` only on the disposable rehearsal project; prior production tags/releases unchanged.
