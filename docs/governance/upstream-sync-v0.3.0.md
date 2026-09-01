# Upstream sync v0.3.0 — execution record

Phase per upstream-sync-runbook.md. Base: fork `main` `93810c50`; target: upstream tag `v0.3.0` = `36f4f6ad7479f1cb90e774e98fdc2ac175ea46c9` (re-verified: published 2026-08-31T00:12:17Z, draft=false, prerelease=false); merge-base `b3bea1ed`. Production stays on `g34057521` throughout — deploy is a separate later phase.

## Inventory — 14 upstream commits (b3bea1ed..v0.3.0)

| Commit | Subject | Areas / notes |
|---|---|---|
| 41545b61 | add missing browser tab titles | apps/web UI |
| 58ff7750 | keep platform and prompt configuration with whoever owns it (#618) | **platform-picks/provider config ownership moved org→brand scope**; apps/web server + lib; feature-matrix impact: provider settings, platform picks |
| 9ed718b7 | tests for timezone utilities | lib tests only |
| 4aefa5f5 | daily blog post | apps/www content |
| f87d2e28 | put the workspace in the URL, sidebar, settings (#576) | **largest change**: brand slug in URLs (`/app/<workspace>/…`), migration **0016** (nullable `brands.slug` + unique (org,slug) index), `brand.slug ?? brand.id` fallback for pre-existing brands, routing/sidebar/settings rewrite, many e2e spec updates |
| 7d3d3a83 | brand slug prefix on one line | UI polish |
| d8a37e5e | organization switcher >3 orgs | UI |
| f72809d7 | gate team page on teamInvites | deployment feature flag gating |
| cf0caf0b | admin links into account menu | UI/routing |
| 9633ca2e | bound citation titles to a sane length | worker/lib citation write path |
| f0014f12 | look for reports in account menu in local e2e | e2e |
| dfd51727 | index citations for analytics queries (#669) | migration **0017** (new covering index on citations, drop old) |
| c443c116 | prepare for release | changesets/versions (packages 0.2.19 → 0.3.x) |
| 36f4f6ad | bump version to 0.3.1 | version bump |

Totals: 255 files, +10249/−3804. Dirs: apps/web 152, packages/lib 23, e2e 14, packages/cloud 6, rest small. Dependencies: **no root package.json / pnpm-workspace / pnpm-lock changes** (supply-chain surface untouched); package versions bumped by upstream Changesets (allowed — upstream release commits, not ours). Upstream workflows: only `.github/contributors.txt` touched — **no workflow YAML changes**, fork-safe CI expected to merge clean.

## Migrations risk review

- **0016_brand_slugs.sql**: `ALTER TABLE brands ADD COLUMN slug text` (nullable) + `CREATE UNIQUE INDEX (organization_id, slug)`. Additive; existing rows get NULL slug; runtime falls back to `brand.id` in URLs (`app-urls.ts: brand.slug ?? brand.id`); slug is set on rename/onboarding via `findUnusedBrandSlug`. Reversal: drop index + column (loses only slugs). Postgres allows multiple NULLs in a unique index → many slugless brands are fine.
- **0017_citations_analytics_index.sql**: creates covering index on citations then drops the old one; sets lock_timeout 5s / statement_timeout 60min; comment advises CONCURRENTLY pre-build for large deployments — ours is small (84 rows in prod, hundreds on test), plain apply is fine. Reversal: recreate old index, drop new. No data mutation.
- Both to be proven on the disposable `aitrckr-test` stack: fresh apply, apply-over-seeded-data, re-apply idempotence, data intact.

## Risk register

| ID | Risk | Mitigation / verification |
|---|---|---|
| RS-1 | Workspace-in-URL rewrite breaks existing local-mode flows (routing/auth) | full stub E2E (local project incl. our phase1 specs) + feature-matrix retest of navigation/prompts/settings on test stack |
| RS-2 | Migration 0016 vs existing brands (NULL slug) | code fallback verified; migrate seeded DB; open UI paths on test stack |
| RS-3 | 0017 index swap locks citations table | tiny data; verified on test stack; production apply gets its own later plan |
| RS-4 | #618 ownership move changes provider config/platform picks semantics | retest provider settings + `enabled_models`/picks behavior on test stack (our prod brand keeps enabled_models NULL→default) |
| RS-5 | Merge conflicts with fork-only surfaces (CI workflows, docs, ops) | conflict-by-conflict resolution; fork-safe CI properties re-asserted post-merge (runner, SHA pins, no secrets, frozen lockfile) |
| RS-6 | Our phase1 e2e specs (63 tests) vs upstream spec rewrites | run repo lint/unit/build + full stub E2E; fix OUR specs if upstream renamed flows (allowed: fork-only test maintenance) |
| RS-7 | Version bumps colliding with our no-version-bump rule | bumps are upstream's release commits, retained verbatim via merge commit — rule applies to our own changes only (documented) |

## Requirements (compact) — verification at PR time

| ID | Requirement | Verify |
|---|---|---|
| REQ-SYNC-001 | Merge is exactly tag v0.3.0 via `--no-ff` merge commit; ancestry preserved | `git log` shows merge commit with parents {fork main, 36f4f6ad}; `git merge-base --is-ancestor 36f4f6ad HEAD` |
| REQ-SYNC-002 | Fork-only surfaces survive (docs/phase1, docs/governance, ops overlay, fork-safe CI) | diff vs pre-merge for those paths = none (or documented deliberate edits); workflow safety grep |
| REQ-SYNC-003 | Migrations 0016/0017 proven on isolated test stack; reversibility documented | test-stack log: fresh apply + seeded apply + re-apply + data checks |
| REQ-SYNC-004 | Full regression green: lint/unit/build local + 5 GitHub checks | local runs + PR checks on final HEAD |
| REQ-SYNC-005 | Production untouched; no prod DB/volume/env used in testing | read-only snapshots before/after phase |
| REQ-SYNC-006 | Feature-matrix areas affected by v0.3.0 retested on test stack | targeted checks: routing/workspace URLs, prompts, provider settings, citations pages, reports menu |

## Gates

| Gate | Meaning | Status |
|---|---|---|
| GATE-US-1 | Preflight + inventory + risk review complete | **PASS** 2026-09-01 (this document; preflight: main==origin clean, 4/4 main CI green, baseline artifacts present, prod HEALTHY Up 16h, tag re-verified) |
| GATE-US-2 | Merge done, conflicts resolved consciously, local regression green | **PASS** — merge f180800e (parents: branch, 36f4f6ad), ZERO conflicts; fork surfaces byte-identical (workflows diff 0); frozen install OK, lint 0, fresh units 944 green (lib 526/web 347/cloud 43/cli 28), build green, clean tree |
| GATE-US-3 | Isolated migration/feature verification green | **PASS (re-closed 2026-09-01 after flake investigation)** — see §Flake investigation below. Migration upgrade-path: 0016/0017 over seeded data, counts identical (3/7/9/15), slug NULL + id-fallback, index swap, re-apply idempotent; fresh-DB apply proven. Final local runs after ALL fixes (incl. app guard + spec sync): full local project **80 passed / 0 failed / 0 flaky / 2 skipped**; touched specs 16/16 across ×5 serial repeats; demo-mode citations spec 21/21 across ×5 serial repeats on the fixed build (skips = WORKER_UP-gated by design); Bruno exit 0; worker stub 1/1; problem specs additionally 26/26 across ≥5 serial repeats each |
| GATE-US-4 | PR checks green; user merge approval | pending |

## Flake investigation (user-directed, 2026-09-01)

- **Local Windows failures (account-menu reports link; brand-slug rename)** — root cause: SSR hydration race. The button/field is in the SSR DOM before React attaches handlers; a single click()/fill() landing pre-hydration is silently lost (trace: "click action done" yet menu never renders; fill lands yet Save never enables). Secondary defect: the rename afterEach silently returned when the slug field was not visible, stranding the fixture at the moved slug and cascading failures into later runs. Fixes (upstream-spec edits, documented divergence): re-drive interactions via expect(...).toPass() gated on REAL state transitions (menu visible / Save enabled / URL moved) — no sleeps, no timeout inflation; afterEach now restores via the slug-independent id URL and verifies the field before acting. Evidence of efficacy: 26/26 serial repeats (≥5× each problem test), full suite 80/0/0/2.
- **Parallel-repeat artifact**: an initial ×5 loop without --workers=1 produced 4 failures — concurrent copies of the same test fighting over one fixture brand; methodology artifact, not product/test flakiness; documented and re-run serially.
- **CI flake, demo citations.spec.ts:36 — RESOLVED, chronology:** (1) First occurrence (run 33521111801, attempt 1): terminal error boundary right after SPA navigation; only an error-context snapshot survived (the then-active trace mode recorded retries only), so the initial working hypothesis — an unrecoverable transient in the route-context load — could not be verified; diagnostics were added instead: playwright trace switched to retain-on-failure. (2) Recurrence (run 33526358621, attempt 1) with the new tracing captured the real exception: TypeError: Cannot read properties of undefined (reading .slug) while building sidebar links — BrandLayout re-renders during a route transition before the next match loader data is committed and passes undefined brand/organization into brandLinkParams → error boundary. The initial hypothesis is REFUTED and withdrawn. (3) Fixes: app guard in the brand layout route (transition frame renders the existing pending skeleton instead of crashing; user-facing, changeset added); the deterministic skeleton frame then exposed the citations.spec sync defect (textContent(body) read immediately after waitForURL) — fixed by waiting for the page heading; the same lost-click-before-hydration pattern was found in the remaining menu specs — all four account-menu call sites now use the shared openAccountMenu helper (retry until the menu is actually open). The earlier local Windows failures were the SAME two defect classes, not a runner-only artifact, and upstream CI success was never sufficient evidence. (4) Verification on the fixed build: full local project 80 passed / 0 failed / 0 flaky / 2 skipped; touched specs 16/16 over ×5 serial repeats; demo citations 21/21 over ×5 serial repeats; CI on 7acf1f5d 5/5 green with zero flaky/failure annotations. No blanket timeouts or sleeps anywhere; retain-on-failure kept for future incidents.

Production deploy/rollback plan: separate phase after this PR merges (build pinned images from the new commit → prodlike acceptance → user-approved cutover; rollback = previous pinned tags per production-manifest.md; DB rollback for 0016/0017 documented above).
