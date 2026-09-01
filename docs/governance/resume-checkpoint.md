# Phase 1.1 — resume checkpoint (no secrets)

Rewritten 2026-09-01 (pre-merge state). A new session resumes from the Phase 1.1 master prompt (local operator artifact, git-excluded) + this file.

## Where we are

- PR: https://github.com/e-orlov/aitrckr/pull/2 (`chore/baseline-freeze-governance` → `main`); working tree clean.
- Last passed gate: **GATE-BF-G1** (L1, F1, C1, C2, G1 all PASS — see gate-record.md). GATE-BF-R1 NOT declared: requires user-approved merge, green push-to-main CI, final production snapshot.
- Requirements: **22 PASS / 1 PLANNED** (only REQ-SCOPE-001 — final post-merge production snapshot).

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

1. Wait 5/5 green checks on current PR HEAD.
2. Ask the user for merge permission again; on approval: **Squash and merge** PR #2.
3. Wait push-to-main CI green; safe fast-forward local `main`.
4. Final read-only production snapshot (`prod-after-merge.txt`), compare with before.
5. Create short branch `chore/phase1.1-closeout` → PR that ONLY closes REQ-SCOPE-001 and records GATE-BF-R1. No direct push to main; no ruleset disabling. **Closeout PR is not merged without separate user permission.**
6. Final report starts with `BASELINE FROZEN / GOVERNANCE READY`.

Blockers: none. Responsible party for merge decisions: user.
