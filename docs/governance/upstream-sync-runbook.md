# Upstream sync runbook — next phase: `sync/upstream-v0.3.0`

Prepared by Phase 1.1. This documents the process; **nothing here has been executed** — `v0.3.0` is not merged and production is not updated.

## Fixed target (verified 2026-09-01)

| Item | Value |
|---|---|
| Upstream release | `elmohq/elmo` tag `v0.3.0` (lightweight tag) |
| Peeled commit | `36f4f6ad7479f1cb90e774e98fdc2ac175ea46c9` |
| Published | 2026-08-31T00:12:17Z, draft=false, prerelease=false |
| Divergence at freeze | fork `main` (`ff23fda6`) is +1 own commit / −14 behind the tag; merge-base `b3bea1ed` |
| Sources | https://github.com/elmohq/elmo/releases/tag/v0.3.0 ; `git fetch upstream --tags` |

Newer upstream `main` is **not** the target; only the exact tag is.

## Preconditions

1. Phase 1.1 PR merged; `main` CI green on the merge commit.
2. Baseline freeze verified: tag `baseline/phase1-production-2026-08-31`, archive + bundle checksums match `SHA256SUMS.txt`.
3. Production healthy (read-only check only).

## Process

1. `git fetch upstream --tags` and re-verify the peeled SHA and release metadata (and signature status if upstream signs).
2. Create `sync/upstream-v0.3.0` from the protected `main`.
3. Inventory the 14 upstream commits: files, DB migrations, workflow changes, dependency changes (`git log --stat main..v0.3.0`, `git diff main...v0.3.0 -- packages/lib/drizzle .github/workflows package.json pnpm-lock.yaml`).
4. Dedicated risk review before merging: DB migrations `0016`/`0017` (data mutation? reversible?), auth/routing changes, provider config changes, E2E changes, overlap with fork-only ops overlay.
5. `git merge --no-ff v0.3.0` into the sync branch — a **normal merge commit**. Never squash, never rebase: upstream ancestry must remain reachable.
6. Resolve conflicts per file, consciously — no blanket `ours`/`theirs`.
7. Preserve fork-only surfaces: `docs/phase1/`, `docs/governance/`, production ops scripts, fork-safe CI (runner/pins/no-secrets properties must survive upstream workflow changes).
8. Validation: GitHub CI on the sync PR **plus** an isolated local test stack (`aitrckr-test` layering per `docs/phase1/runbook.md`). Never point candidate code at the production DB/volume.
9. PR `sync/upstream-v0.3.0` → `main`, merged with **Create a merge commit** (ruleset allows it; repo rebase-merge is off; do not squash).
10. Production deploy is a separate, user-approved gate after merge: prodlike acceptance, then a dedicated deploy/rollback/data-compatibility plan for migrations before the production DB is ever migrated.

## Explicitly forbidden

- GitHub `Sync fork` button (bypasses review, may take upstream `main` instead of the tag).
- Squash/rebase of the sync PR.
- Mixing Dependabot or any unrelated changes into the sync PR.
- Running migrations against the production database during sync validation.
