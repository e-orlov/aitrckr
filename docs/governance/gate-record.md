# Phase 1.1 — V-gate record

| Gate | Meaning | Status | UTC | HEAD | Notes |
|---|---|---|---|---|---|
| GATE-BF-L1 | Baseline lock | **PASS** | 2026-09-01T05:58Z | ff23fda6 | see entry |
| GATE-BF-F1 | Freeze complete | **PASS** | 2026-09-01T06:35Z | ff23fda6 | see entry |
| GATE-BF-C1 | CI design safe | **PASS** | 2026-09-01T07:05Z | branch, pre-PR | see entry |
| GATE-BF-C2 | CI operational | not evaluated | — | — | — |
| GATE-BF-G1 | Governance enforced | not evaluated | — | — | — |
| GATE-BF-R1 | Phase accepted | not evaluated | — | — | — |

## GATE-BF-L1 entry — 2026-09-01T05:58Z

- Git: working tree clean; local `main` == `origin/main` == `ff23fda683f16f150e00bd65aa133f6a9f0d96ce`; remotes origin=e-orlov/aitrckr, upstream=elmohq/elmo; both master prompts excluded via `.git/info/exclude` (untracked, never staged).
- PR #1 lineage: `refs/pull/1/head` fetched = `7ab63266f914e15eb9a90d48250e58792f36eec0`; build commit `340575215b81…` confirmed as its ancestor (`git merge-base --is-ancestor` OK).
- Docker-context equivalence: `git diff --name-only 34057521 ff23fda6` = 13 files, all under `docs/phase1/` (0 outside); `.dockerignore` excludes `.env*`, `docs`, `e2e` → image build context identical between build commit and merged main.
- Production before-snapshot (read-only, 2026-09-01T05:52:59Z): containers `6740fbd1…`/`7237ef2d…`/`019b68e1…` Up 10h since 2026-08-31T19:39:11Z; image IDs `8033bfb4b0ff…`/`5bdf8185e703…`/`a31ef76c3a5a…`, postgres `d3e1620b…` — all match §2.2 of the master prompt; volume `elmo_postgres_data`; 3 aitrckr-elmo-* tasks Ready with expected arguments; web HTTP 200. Snapshot: `%USERPROFILE%\.elmo\phase11-evidence\prod-before.txt`.
- GitHub API audit (authenticated as e-orlov): public repo, default `main`, merge methods squash/merge/rebase all ON, auto-merge OFF, auto-delete OFF; `main` protected=false, 0 rulesets; Actions enabled, allowed_actions=all, sha_pinning_required=false, default workflow token permissions=read, PR-approval by Actions=false; 9 workflows all state=active but **0 runs in history**; 0 self-hosted runners, 0 secrets, 0 environments, 0 webhooks, 0 releases, 0 tags.
- Workflow inventory: fork-relevant needing runner adaptation — build.yaml, e2e.yaml, mode-compat.yaml, license-check.yaml (all Blacksmith runners; actions pinned by version tag, not SHA; nick-fields/retry in build+e2e). Unsafe/inapplicable — cla-check.yaml (owner-exempt anyway), claude.yml (secrets + comment triggers), daily-blog-draft.yaml (cron 13:00 + Oxylabs/Anthropic secrets + Blacksmith), publish.yaml (npm publish + NPM_TOKEN/Discord), test-providers.yaml (cron 4×/day + provider secrets). Matches master-prompt expected inventory; no new workflows.
- Upstream target verified: `v0.3.0` peeled `36f4f6ad7479f1cb90e774e98fdc2ac175ea46c9`, published 2026-08-31T00:12:17Z, draft=false, prerelease=false; fork main +1 own commit / −14 behind tag; merge-base `b3bea1ed`. Fetch/read only, no merge.
- Working branch `chore/baseline-freeze-governance` created from exact `origin/main`.
- Result: **PASS** — no discrepancies against master prompt §2; scope locked.

## GATE-BF-F1 entry — 2026-09-01T06:35Z

- Release immutability enabled BEFORE publish (user amendment 1): `PUT /repos/…/immutable-releases` → HTTP 204, `GET` → `enabled=true`.
- Tag: annotated `baseline/phase1-production-2026-08-31` (object `5cdecb96…`) → `ff23fda6…`; only the tag pushed; remote ref type = tag.
- Release (user amendment 2 followed): created as draft, `SHA256SUMS.txt` (neutral names, no paths) attached, then published with `prerelease=false`, `make_latest=false`; API shows `draft=false`, `immutable=true`, 1 asset. Deviation: sole release is auto-designated Latest by GitHub (GraphQL `isLatest=true`) despite `make_latest=false` — accepted, self-corrects at the next ordinary release.
- Archive: single `docker image save` (4 images, OCI, 496,995,328 bytes) in `<OneDrive>\ELMO-Baselines\phase1-production-2026-08-31\`; tar readable, manifest lists exactly the 4 refs; SHA-256 `f1c62f66…de860`. Big tar kept OFF GitHub (user amendment 4).
- Bundle (user amendment 3 followed): explicit refs incl. `refs/archive/build-commit=34057521`; `git bundle verify` complete; both `ff23fda6` and `34057521` proven restorable in a disposable temp clone; SHA-256 `ec6559c6…bf0c`.
- Secret scan: image env names stock-only, history 0 hits, `--network none` file scan clean, `.dockerignore` exclusions confirmed; no DB volume/data in any artifact.
- Post-freeze production snapshot: identical container IDs and StartedAt (only the "Up N hours" text advanced), HTTP 200 — production untouched.
- Result: **PASS** (REQ-FRZ-001…005 closed; FRZ-001 tag-ruleset protection completes at Stage F).

## GATE-BF-C1 entry — 2026-09-01T07:05Z

- Inapplicable workflows disabled via official workflow state (API `PUT …/disable`): cla-check.yaml, claude.yml, daily-blog-draft.yaml, publish.yaml, test-providers.yaml — all `disabled_manually`, re-verified by API; total runs in repo history still 0 (no scheduled/secret workflow ever started).
- Adapted workflows (minimal diff on upstream files, no duplicate orchestration): build.yaml, e2e.yaml, mode-compat.yaml, license-check.yaml — runners `blacksmith-*` → `ubuntu-24.04`; every `uses:` pinned to a verified full-length commit SHA with release comment (docs/governance/action-pins.md); `nick-fields/retry` removed in favor of a shell retry loop; all installs `pnpm install --frozen-lockfile`; checkout `persist-credentials: false` everywhere; e2e log redaction (generated .env printed as key names only); e2e teardown `docker compose down -v` under `if: always()` (CI runner only); upstream `permissions: contents: read`, concurrency cancel-in-progress and timeouts retained.
- Static checks: js-yaml parse OK for all 4 files; `secrets.*` grep = 0 in enabled workflows; no `pull_request_target`/`workflow_run`; no Blacksmith/self-hosted references; triggers = push/PR to main + workflow_dispatch only.
- Actions repository settings (before → after, API-verified): allowed_actions all → **selected** (GitHub-owned + `pnpm/action-setup@*`, verified_allowed=false); **sha_pinning_required=true**; default workflow token permissions read (unchanged); can_approve_pull_request_reviews=false (unchanged); 0 self-hosted runners; 0 secrets; 0 environments.
- Isolation: no deployment jobs, no VM credentials/endpoints anywhere in enabled workflows (grep for RDP/SSH/tunnel/host patterns = 0).
- Result: **PASS**. Operational proof (GATE-BF-C2) deferred to the GitHub-hosted PR run.
