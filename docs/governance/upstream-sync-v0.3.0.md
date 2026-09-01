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
| GATE-US-2 | Merge done, conflicts resolved consciously, local regression green | pending |
| GATE-US-3 | Isolated migration/feature verification green | pending |
| GATE-US-4 | PR checks green; user merge approval | pending |

Production deploy/rollback plan: separate phase after this PR merges (build pinned images from the new commit → prodlike acceptance → user-approved cutover; rollback = previous pinned tags per production-manifest.md; DB rollback for 0016/0017 documented above).
