# Branching and release policy (fork e-orlov/aitrckr)

Established by Phase 1.1. Applies to this fork only; upstream keeps its own rules.

## Branch model

- `main` — always green and deployable, but **never auto-deployed**. What actually runs in production is defined by an immutable baseline tag + `docs/phase1/production-manifest.md`, not by the tip of `main`.
- Own work — short-lived `feat/*`, `fix/*`, `chore/*` branches off `main`.
- Urgent production fix — short-lived `hotfix/*` off the current production-eligible baseline (the tag the running images were built from), PR into `main`.
- Upstream release adoption — short-lived `sync/upstream-vX.Y.Z` off `main` (see `upstream-sync-runbook.md`).
- No long-lived `develop`/`test`/`upstream-test` branches. dev/test/prod are **environments** (see `docs/phase1/runbook.md`), not branches.
- Head branches are deleted after merge (repo auto-delete is ON); history lives in the PR and `main`.

## Merge policy

| PR type | Method | Why |
|---|---|---|
| own `feat/*`, `fix/*`, `chore/*`, `hotfix/*` | **Squash and merge** | one reviewable commit per change on `main` |
| `sync/upstream-vX.Y.Z` | **Create a merge commit** | preserves upstream ancestry; squash/rebase would orphan upstream SHAs |

- Direct push to `main`: blocked (ruleset).
- Force-push / branch deletion of `main`: blocked (ruleset).
- Rebase merge: disabled in repo settings so it cannot be picked accidentally for a sync PR.
- `Require linear history`: intentionally OFF — a linear-history rule would forbid the upstream merge commits.
- Auto-merge: OFF by default.
- Required approving reviews: 0 (solo maintainer); required CI checks replace human review. Break-glass: the owner may temporarily disable a ruleset in Settings with a documented reason — this is exceptional, not a routine bypass.
- GitHub's `Sync fork` button is **not used**: it bypasses staged review and can pull upstream `main` instead of an exact release tag.

## Releases and deploys

- Baseline/production states are frozen as annotated tags `baseline/*` + GitHub Releases (immutable releases are enabled repo-wide). The tag ruleset forbids deleting or moving `baseline/**`.
- A GitHub Release here documents a frozen state; it is **not** an upstream SemVer release and must not be marked "Latest" ahead of ordinary releases.
- Deploy/rollback are explicit operator actions per `docs/phase1/production-manifest.md`; CI never touches production (no self-hosted runners, no deployment jobs, no VM credentials).
- New version path: `sync/upstream-vX.Y.Z` or own PR → green CI on GitHub-hosted runner → merge → isolated prodlike acceptance → user-approved deploy.

## Dependabot

Inherited config (`.github/dependabot.yml`, weekly npm + github-actions) may open PRs. They get no bypass, are never auto-merged, must pass the same required checks, and are **never** combined with an upstream sync PR. Action-bump PRs must keep full-SHA pins (`docs/governance/action-pins.md`).
