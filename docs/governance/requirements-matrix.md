# Phase 1.1 — Requirements / Verification Matrix (canonical)

Master prompt: `ELMO_Phase_1_1_Baseline_Freeze_Repository_Governance_Master_Prompt.md` v1.0 (local operator artifact, excluded from Git). Baseline: fork `main` @ `ff23fda683f16f150e00bd65aa133f6a9f0d96ce`; production build commit `340575215b814fc1afc43d2d830ac0d431ac5826` (ancestor of preserved `refs/pull/1/head` = `7ab63266`).

Statuses: `PLANNED`, `PASS`, `FAIL`, `BLOCKED`, `NOT APPLICABLE`.

| ID | Requirement | Verification | Expected result | Actual result | Evidence | Status | Commit |
|---|---|---|---|---|---|---|---|
| REQ-SCOPE-001 | Production runtime unchanged | OT-PROD-001 | before/after container IDs, image IDs, StartedAt, task definitions, HTTP identical | before snapshot 2026-09-01T05:52:59Z: containers 6740fbd1/7237ef2d/019b68e1, StartedAt 2026-08-31T19:39:11Z, images 8033bfb4/5bdf8185/a31ef76c + pg d3e1620b, volume elmo_postgres_data, 3 tasks Ready, HTTP 200; after: pending | `%USERPROFILE%\.elmo\phase11-evidence\prod-before.txt` | PLANNED | — |
| REQ-SCOPE-002 | Upstream v0.3.0 not merged in Phase 1.1 | ST-UP-001 | no upstream commits in branch/main; ancestry unchanged | — | — | PLANNED | — |
| REQ-FRZ-001 | Baseline pinned by immutable annotated tag | IT-FRZ-001 | annotated tag on ff23fda6, pushed, protected by tag ruleset | annotated tag baseline/phase1-production-2026-08-31 (object 5cdecb96) on ff23fda6, pushed; remote ref verified as annotated tag; protection by tag ruleset pending Stage F | git cat-file; GitHub API git/ref | PASS (ruleset pending Stage F) | ff23fda6 (tag) |
| REQ-FRZ-002 | GitHub Release describes baseline, not latest | IT-FRZ-002 | draft=false, make_latest=false, chosen prerelease state, accurate notes | release published: draft=false, prerelease=false, immutable=true, asset SHA256SUMS.txt; make_latest=false requested at publish and re-PATCHed; deviation: sole release of the repo is auto-designated Latest by GitHub (isLatest=true) — shifts to next ordinary release automatically | release API + GraphQL; freeze manifest | PASS (deviation documented) | ff23fda6 |
| REQ-FRZ-003 | Runtime images saved in one deduplicated archive | OT-FRZ-003 | single tar of 4 images, readable, SHA-256 recorded | single docker image save of 4 images (OCI, compressed layers), 496,995,328 bytes; tar readable, manifest.json lists exactly the 4 refs; SHA-256 f1c62f66…de860 | checksums.json; SHA256SUMS.txt; freeze manifest | PASS | g34057521 images |
| REQ-FRZ-004 | Git history saved offline | OT-FRZ-004 | git bundle verify OK; refs/SHA confirmed in temp clone | bundle verify = complete history; list-heads shows explicit refs incl. refs/archive/build-commit=34057521; both commits restorable in disposable temp clone (cat-file -t = commit); SHA-256 ec6559c6…bf0c | freeze manifest; temp clone check | PASS | ff23fda6 + 34057521 |
| REQ-FRZ-005 | Freeze artifacts contain no secrets/DB data | ST-SEC-001 | image config/file scan + archive scope scan clean | image Config.Env = stock names only; history 0 secret-indicator hits; --network none scan: no .env in image; .dockerignore excludes .env*/docs/e2e; archives exclude DB volume; SHA256SUMS.txt has neutral names, no paths | freeze manifest §exclusions | PASS | g34057521 images |
| REQ-CI-001 | CI on standard GitHub-hosted runner only | ST-CI-001 | enabled workflows use ubuntu-24.04; run metadata hosted | — | — | PLANNED | — |
| REQ-CI-002 | CI uses no repo secrets, least privilege | ST-CI-002 | no `secrets.*` in enabled workflows; contents: read | — | — | PLANNED | — |
| REQ-CI-003 | lint + unit + build green | IT-CI-003 | green GitHub checks with counts | — | — | PLANNED | — |
| REQ-CI-004 | Stub E2E green without paid providers | IT-CI-004 | SCRAPE_TARGETS=stub:stub, synthetic env, green | — | — | PLANNED | — |
| REQ-CI-005 | Inherited unsafe workflows do not run in fork | IT-CI-005 | disabled_manually state via API; no scheduled runs | — | — | PLANNED | — |
| REQ-CI-006 | Actions pinned to full SHAs; frozen lockfile | ST-CI-006 | 40-char SHAs verified against source repos; --frozen-lockfile | — | — | PLANNED | — |
| REQ-CI-007 | CI has no path to production | ST-CI-007 | no self-hosted runner/deploy/VM credentials/tunnels | — | — | PLANNED | — |
| REQ-GOV-001 | main changes only via PR with green checks | IT-GOV-001 | active ruleset; non-destructive validation | — | — | PLANNED | — |
| REQ-GOV-002 | force-push/deletion of main blocked | IT-GOV-002 | ruleset API evidence (no destructive test) | — | — | PLANNED | — |
| REQ-GOV-003 | Solo workflow: 0 external reviewers | IT-GOV-003 | required approvals = 0 with PR requirement active | — | — | PLANNED | — |
| REQ-GOV-004 | Merge policy: squash for own, merge commit for sync | ST-GOV-004 | both methods allowed; no linear history; rebase policy fixed | — | — | PLANNED | — |
| REQ-GOV-005 | Baseline tags protected | IT-GOV-005 | tag ruleset on `baseline/**` blocks delete/update | — | — | PLANNED | — |
| REQ-GOV-006 | Branch/release/deploy policy documented | ST-GOV-006 | policy docs + PR template reviewed | branching-and-release-policy.md + upstream-sync-runbook.md + .github/pull_request_template.md written; reviewed against master prompt F.1–F.5 | docs/governance/*; PR template | PASS (docs; rulesets at Stage F) | branch |
| REQ-UP-001 | Exact v0.3.0 fixed as next target | ST-UP-001 | peeled SHA 36f4f6ad + release metadata in handoff | verified 2026-09-01: peeled `36f4f6ad7479f1cb90e774e98fdc2ac175ea46c9`, published 2026-08-31T00:12:17Z, draft=false, prerelease=false; fork +1/−14 vs tag, merge-base b3bea1ed; lightweight tag upstream (noted) | upstream-sync-runbook.md §Fixed target | PASS | 621bd85c+ |
| REQ-UP-002 | Next sync preserves ancestry | ST-UP-002 | runbook mandates merge commit, forbids squash/rebase for sync | upstream-sync-runbook.md mandates --no-ff merge commit for sync PRs, forbids squash/rebase and the Sync-fork button; repo rebase-merge to be disabled at Stage F | upstream-sync-runbook.md; branching policy | PASS (settings at Stage F) | branch |
| REQ-TRACE-001 | No orphan requirements/tests/changes | ST-TRACE-001 | bidirectional scan = 0 orphans | — | — | PLANNED | — |
