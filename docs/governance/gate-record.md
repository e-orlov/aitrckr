# Phase 1.1 — V-gate record

| Gate | Meaning | Status | UTC | HEAD | Notes |
|---|---|---|---|---|---|
| GATE-BF-L1 | Baseline lock | **PASS** | 2026-09-01T05:58Z | ff23fda6 | see entry |
| GATE-BF-F1 | Freeze complete | **PASS** | 2026-09-01T06:35Z | ff23fda6 | see entry |
| GATE-BF-C1 | CI design safe | **PASS** | 2026-09-01T07:05Z | branch, pre-PR | see entry |
| GATE-BF-C2 | CI operational | **PASS** | 2026-09-01T06:45Z | 60d08af0 | see entry |
| GATE-BF-G1 | Governance enforced | **PASS** | 2026-09-01T06:52Z | 60d08af0 | see entry |
| GATE-BF-R1 | Phase accepted | **PASS** | 2026-09-01T09:20Z | b38f0fc6 | see entry |

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

## GATE-BF-C2 entry — 2026-09-01T06:45Z

- PR #2 HEAD `60d08af0`, event pull_request, all 5 checks green on GitHub-hosted `ubuntu-24.04` (job labels API-verified): Build 2m40s (lint → check-types → unit → test:scripts → build + clean-tree → storybook), E2E Integration Tests 8m58s (stub worker, 5 mode phases, Bruno, worker job test, teardown), Scheduling Policy Verification 2m31s, smoke 1m19s, Dependency License Audit 50s.
- No blind reruns needed (first attempt green). No secrets available to any run (repo has none). Runs: 33477198677, 33477198720, 33477198724, 33477198736.
- Result: **PASS**.

## GATE-BF-G1 entry — 2026-09-01T06:52Z

- Branch ruleset `main-protection` (id 21989411, active): pull_request (0 approvals, conversation resolution, merge methods squash+merge), required status checks ×5 (strict up-to-date), deletion blocked, non_fast_forward blocked; no linear history, no merge queue, no deployment/signing requirement, no bypass actors.
- Tag ruleset `baseline-tags-protection` (id 21989413, active): `refs/tags/baseline/**` — deletion, update, non_fast_forward blocked; `v*` deliberately untouched.
- Effective-rules readback: `GET /rules/branches/main` returns all four rule types; non-destructive validation: PR #2 `mergeable=MERGEABLE, mergeStateStatus=CLEAN` under the new ruleset with green checks (no destructive push test by design).
- Repo settings PATCH readback: rebase merge OFF, squash ON, merge commit ON, auto-delete head branches ON. Dependabot inherited (weekly npm+actions): no bypass, no auto-merge, same required checks (policy doc).
- Break-glass documented: owner disables ruleset in Settings with recorded reason (branching-and-release-policy.md).
- Rollback: rulesets 21989411/21989413 deletable via API; merge settings revertible via PATCH.
- Result: **PASS**.

## Impact analysis — docs-only commits after PR HEAD 60d08af0

- Commits `f70711e2` (gate evidence) and the present correction commit touch only `docs/governance/**` — no workflow, script, config or code surface of any passed gate. GATE-BF-C1 (CI design) and GATE-BF-G1 (governance settings) surfaces are unchanged; no reopening required.
- GATE-BF-C2 re-confirmed on `f70711e2`: all 5 required checks re-ran green on GitHub-hosted runners (Build 2m44s, E2E 18m13s, Scheduling 2m20s, smoke 1m11s, License 54s); PR mergeable=MERGEABLE, state=CLEAN under the active ruleset. The same re-confirmation is expected on the correction commit's HEAD before merge.
- Latest-flag deviation on the baseline release is **explicitly user-accepted (2026-09-01)**; the release is not to be deleted or recreated (REQ-FRZ-002).
- GATE-BF-R1 is NOT declared. Closure plan (user-directed): after squash merge of PR #2 + green push-to-main CI + final read-only production snapshot, a short `chore/phase1.1-closeout` PR closes REQ-SCOPE-001 and records GATE-BF-R1; direct push to main and ruleset disabling are forbidden; the closeout PR is not merged without separate user permission.

## GATE-BF-R1 entry — 2026-09-01T09:20Z

- Merge: PR #2 squash-merged with explicit user permission at HEAD `928ddf3776997e92f5ad8a901cc99cb286de1845`; squash commit on `main`: **`b38f0fc68da2c26db2e62500688665f34d5c9b30`** (single parent `ff23fda6` — squash confirmed); head branch auto-deleted; exactly the 12 expected files.
- Push-to-main CI (event=push, branch=main, head_sha=b38f0fc6, all on GitHub-hosted ubuntu-24.04, all success): Build run 33489462447; E2E Tests run 33489462462 (jobs: E2E Integration Tests 08:54:45→09:03:47Z, Scheduling Policy Verification); License Check run 33489462495; Deployment Smoke Tests run 33489462391. URLs: https://github.com/e-orlov/aitrckr/actions/runs/33489462447 , https://github.com/e-orlov/aitrckr/actions/runs/33489462462 , https://github.com/e-orlov/aitrckr/actions/runs/33489462495 , https://github.com/e-orlov/aitrckr/actions/runs/33489462391 .
- Production comparison: snapshots before (05:52:59Z) / post-freeze (06:35Z) / post-merge (09:04:52Z) identical — container IDs `6740fbd1/7237ef2d/019b68e1`, image IDs g34057521 + pg `d3e1620b`, StartedAt 2026-08-31T19:39:11Z, volume `elmo_postgres_data`, task definitions unchanged, HTTP 200, `health-elmo.ps1` HEALTHY exit 0. REQ-SCOPE-001 **PASS**.
- Governance re-verified read-only: rulesets 21989411 (main: PR-only, 5 required checks, deletion+non-FF blocked) and 21989413 (`baseline/**`: deletion/update/non-FF blocked) active; rebase OFF, squash+merge ON, auto-delete ON; release published+immutable with `SHA256SUMS.txt`; tag still → `ff23fda6`. Latest-flag deviation remains user-accepted documentation-only.
- Workflow states, final and **user-accepted 2026-09-01**: cla-check/claude/publish `disabled_manually`; daily-blog-draft/test-providers `disabled_fork` (GitHub's own equivalent-disabled state for scheduled workflows in forks); all five inert; both scheduled workflows have 0 runs ever; no state re-mutation performed.
- Explicitly NOT done: `sync/upstream-v0.3.0` not started (v0.3.0 not an ancestor of main); no production deploy/build/migration; no ruleset/setting changes in this stage.
- Result: **PASS**. Recorded via docs-only `chore/phase1.1-closeout` PR (merge requires separate user permission).
