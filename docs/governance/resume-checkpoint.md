# Phase 1.1 — resume checkpoint (no secrets)

Rewritten 2026-09-01 (closeout state).

## Where we are

- Phase 1.1 substantively COMPLETE: PR #2 squash-merged into main as **b38f0fc68da2c26db2e62500688665f34d5c9b30** (user-approved); push-to-main CI 5/5 green on that SHA (hosted ubuntu-24.04); production unchanged across before/post-freeze/post-merge snapshots; governance re-verified.
- Gates: L1, F1, C1, C2, G1, **R1 — all PASS** (gate-record.md).
- Requirements: **23 PASS / 0 PLANNED / 0 FAIL / 0 BLOCKED**.
- Pending: docs-only PR chore/phase1.1-closeout (this record) awaits SEPARATE user merge permission; squash on approval.
- Workflow states user-accepted: 3× disabled_manually + 2× disabled_fork (equivalent-disabled for fork schedules), all inert, 0 runs.
- Next possible phase AFTER closeout merge: sync/upstream-v0.3.0 per upstream-sync-runbook.md — NOT started; production deploy NOT performed.

## GitHub mutations actually applied (with rollback)

| Mutation | State | Rollback |
|---|---|---|
| Release immutability | `enabled=true` (PUT /immutable-releases) | intentionally permanent |
| Tag `baseline/phase1-production-2026-08-31` | annotated, object `5cdecb96` → `ff23fda6`, pushed | keep (frozen baseline) |
| Release for that tag | published, `prerelease=false`, `immutable=true`, asset `SHA256SUMS.txt`; user-accepted deviation: sole stable release shows as Latest despite `make_latest=false`; do NOT delete/recreate | keep |
| 5 workflows disabled | cla-check, claude, daily-blog-draft, publish, test-providers = `disabled_manually` | API re-enable |
| Actions permissions | `allowed_actions=selected` (GitHub-owned + `pnpm/action-setup@*`), `sha_pinning_required=true` | PATCH back |
| Branch ruleset `main-protection` | id 21989411, active: PR-only (0 approvals, conversation resolution, squash+merge), 5 required checks strict, deletion+force-push blocked | delete ruleset |
| Tag ruleset `baseline-tags-protection` | id 21989413, active: `baseline/**` deletion/update/non-FF blocked | delete ruleset |
| Repo merge settings | rebase OFF, auto-delete head branches ON | PATCH back |

## Freeze artifacts

OneDrive `<OneDrive>\ELMO-Baselines\phase1-production-2026-08-31\`: image tar (496,995,328 B, SHA-256 `f1c62f66…de860`), git bundle (12,410,354 B, SHA-256 `ec6559c6…bf0c`, holds `ff23fda6`, `34057521`, PR#1 head, tag), `SHA256SUMS.txt`, `checksums.json`. Big tar stays off GitHub; no public links.

## Production (READ-ONLY this phase)

Snapshots identical at 05:52:59Z and post-freeze: containers `6740fbd1/7237ef2d/019b68e1`, StartedAt 2026-08-31T19:39:11Z, images `g34057521` + pg `d3e1620b`, 3 tasks Ready, HTTP 200. Evidence: `%USERPROFILE%\.elmo\phase11-evidence\prod-{before,after-freeze}.txt`.

## Next exact actions

1. Wait 5/5 green checks on the closeout PR HEAD; verify mergeable=CLEAN.
2. STOP: ask the user for merge permission for the closeout PR (squash).
3. After merge: fast-forward local main; final report starts with BASELINE FROZEN / GOVERNANCE READY.
4. sync/upstream-v0.3.0 only on a separate explicit user command.

Blockers: none. Responsible party for merge decisions: user.
