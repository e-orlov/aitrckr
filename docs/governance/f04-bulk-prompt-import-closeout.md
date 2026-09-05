# F-04 Bulk Prompt Import with Tags — production closeout

Status: **PASS / CLOSED** 2026-09-05. Sanitized evidence for recovery and audit; raw evidence, dumps and screenshots live outside Git under the operator's private `.elmo` evidence and backup directories.

## Identities

| Item | Value |
|---|---|
| Starting baseline (main, origin/main, production source) | `33c94cd175f9b128cfd03901ff04ab51fc189f45`, images `g33c94cd1` (web `c824e3ba857e`, worker `fd2cff1e3a0f`, db-migrate `7bd954cc6698`) |
| Feature PR | [#15](https://github.com/e-orlov/aitrckr/pull/15), head `5320efd9`, required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit all success |
| Application source (`F04_SOURCE_SHA`) | `189e084136d1035706113aa199544032978b2798` — squash merge of #15; post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check all success |
| Images (built once, clean detached worktree at the source commit) | `elmo-web:g189e0841` `sha256:86f6cc58d2568f08f283a39133bffefe2521c16058c59160b5535b11d58da348`; `elmo-worker:g189e0841` `sha256:507684a5a3f9f7e03f49113b57e76b6ac240285acde1e9331ff8153f2112ce71`; `elmo-db-migrate:g189e0841` `sha256:d012b3efdcb2d0755fba4f7167e6e5b4db2e8d2e97e038dd79ecbf5a9853ae61`; same IDs in rehearsal and production |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, volume `elmo_postgres_data`, container not recreated by the cutover |
| Migration journal | 20 before and after (F-04 has no migration) |
| Rollback target | `g33c94cd1` trio above, present locally; rollback = `gen-prod-env.cjs %USERPROFILE%\.elmo g33c94cd1` + `docker compose up -d --no-build` (rehearsed: old build reads and writes the same `text[]` tag data) |
| Cutover | 2026-09-04T23:27:24Z `docker compose up -d --no-build` (project `elmo`), web HTTP 200 at 23:27:36Z (≈12 s), config secrets/settings hash-equal before/after regeneration |
| Real-life acceptance | 2026-09-05T05:28Z paste/stage/save by the operator in the production UI; verified 05:29–05:31Z (below) |
| Closeout documentation commit | the commit carrying this file — documentation only, not an image source |

## Delivered behavior

- "Add Multiple" line grammar `prompt text;tag1;tag2` (LF/CRLF): first field prompt, later fields user tags; a line without `;` is an untagged prompt; `;` is reserved (no quoting/escaping).
- Tags use the shared sanitizer (trim, lowercase, drop empties, stable dedupe) both in the browser parser and at the server save boundary (`planPromptSave`), for inserts and updates. `systemTags` remain server-computed.
- A non-blank line with an empty first field blocks the whole Add with an accessible error naming the 1-based line numbers; blank lines stay a skipped-lines notice; duplicates (prompt text only, tags never merged) and the 100-prompt cap behave as before.
- Nothing is written until the existing Save changes; the existing transactional save and batch scheduler are unchanged.

## Requirement traceability

| Requirement | Evidence | Verification IDs | Status |
|---|---|---|---|
| F04-FR-001 semicolon parsing | `packages/lib/src/bulk-prompts.ts` + `bulk-prompts.test.ts` | UT-001, UT-005, UT-008 | PASS |
| F04-FR-002 tags stay on their row | parser records → `newPromptEntry({value,tags})`; story `AddMultipleWithTags`; E2E; live chips = DB arrays | UT-001, UT-014, UI-003, LIVE-AT-002 | PASS |
| F04-FR-003 legacy untagged paste | UT-002; E2E legacy test; live prompt C `tags: []` | UT-002, UI-010 | PASS |
| F04-FR-004 shared normalization | `user-tags.ts` re-exported by `tag-utils.ts`; UT-003–005; `prompt-save.test.ts` | UT-003–UT-005, IT-002 | PASS |
| F04-FR-005 invalid lines | UT-006, UT-016; story `AddMultipleMissingPrompt`; E2E alert "Lines 2 and 3 …" | UT-006, UI-007 | PASS |
| F04-FR-006 duplicates, no merge | UT-009–011; E2E notice + `dup-tag` never staged | UT-009–UT-011, UI-008 | PASS |
| F04-FR-007 capacity / entitlements | UT-012, UT-013; story `AddMultipleOverCapacity`; `entitlements/guards.test.ts` green; server `decidePromptCap` unchanged | UT-012, UT-013, UI-009, IT-005 | PASS |
| F04-FR-008 review before write | E2E + rehearsal: DB unchanged after paste and after Add | UI-003, UI-004, LIVE-AT-001 | PASS |
| F04-FR-009 durable persistence | E2E, rehearsal and live: save → DB tags/system_tags → reload → tag filter | UI-005, UI-006, IT-001, IT-003, LIVE-AT-002 | PASS |
| F04-FR-010 server-boundary sanitation | `planPromptSave` writes `after.tags` for inserts and updates; single `db.transaction` unchanged | IT-001–IT-004 | PASS (IT-004 by structure: one transaction; live batch shares one `created_at`) |
| F04-FR-011 existing scheduler | E2E, rehearsal (stub worker) and live: exactly one pending `process-prompt` per new prompt, none added by re-save | IT-006–IT-008, LIVE-AT-003, REG-004 | PASS (IT-008 unchanged post-commit `.catch` path, not induced) |
| F04-FR-012 discoverable syntax | textarea name/description, help line, `role="alert"`; E2E + rehearsal | UI-001, UI-007 | PASS |
| F04-NFR-001…007 | 11-file diff, no new architecture; stub-only tests; commit-addressed images; metadata-only evidence | REG-001–004, SYS-001–006, IMG-001/002, REH-001–004, DEP-001–003 | PASS |

## Verification summary

- Local (2026-09-04, Windows VM): `pnpm lint` 0; `pnpm turbo check-types` 0; `pnpm test` 0 (lib 629, web 369, config 93, cloud 43, cli 28); `pnpm test:scripts` 0; `pnpm build` 0; Storybook `prompts-list-editor` 11/11 (the unrelated `cloud-billing` "$3,090" story fails identically at the baseline on this Windows locale and passes in CI); Playwright `local` project 83 passed / 2 worker-gated skips on the `aitrckr-test` stack; Bruno 54/54 requests, 116/116 assertions; Playwright `worker` project 1 passed with `SCRAPE_TARGETS=stub:stub`.
- Rehearsal (`elmo-f04-rehearsal`, own config dir/volume/network, web 127.0.0.1:1516, pg 127.0.0.1:5434, fresh keys, placeholder provider key): production dump `elmo-prod-pre-f04-rehearsal-20260904-231405.dump` (1,406,709 B, sha256 `75a1c570…88d2`) restored with identical control counts; `g189e0841` booted with `--no-build`, journal 20; UI paste→stage→save→reload→filter passed with DB/queue checks; stub worker converged each new prompt to 1 completed + 1 created job, 0 duplicate chains, `[stub_1]` only; rollback to `g33c94cd1` booted, read and wrote the tag data; switched back; project removed with `down -v` (that project only). Production untouched throughout.
- Pre-deploy backup `elmo-prod-pre-f04-cutover-20260904-232542.dump` (1,406,943 B, sha256 `26c1ac00…1874`), TOC 197, control counts brands 1 / prompts 27 / prompt_runs 219 / citations 649 / source classifications 61 / journal 20 / pending 27 / users 1, restored into a disposable container with identical counts. Config backed up (`elmo.yaml` + `.env`, owner-only ACL); 12 critical keys hash/length-equal after regeneration.
- Post-cutover: containers healthy, restarts 0, `health-elmo.ps1` HEALTHY, HTTP 200, pre/post counts identical, journal 20, 0 error lines, watchdog result 0, no rollback criterion triggered.

## Real-life acceptance (metadata only)

Brand `arag`, three new prompts saved by the operator through `http://localhost:1515` in one transaction (identical `created_at 2026-09-05 05:28:10.05Z`):

| Prompt id | sha256[:16] of text | length | user tags | system_tags | enabled |
|---|---|---|---|---|---|
| `f3aa1469-7d31-4505-84e2-af824a53e39c` | `e42b397ef432f7eb` | 54 | `["recommendation visibility","aktuell","rechtsschutz"]` | `["unbranded"]` | yes |
| `9c262a61-bf4c-4d3d-a210-3c7d38f880a1` | `25ddde57a887d25c` | 76 | `["preis-leistung"]` | `["unbranded"]` | yes |
| `b08c301f-6f75-4bf2-b4b3-e2b5fd3dafaf` | `546793716bfb5626` | 64 | `[]` | `["unbranded"]` | yes |

Brand prompts 27 → 30, brand-wide normalized duplicates 0, no empty/upper-case/duplicate tags. Queue: each prompt 1 completed first job (normal cadence run, `chatgpt/openrouter`) + exactly 1 created successor, 0 duplicate chains anywhere. Read-only UI verification (headless Chromium, operator's account): full reload shows the three rows with chips identical to the DB arrays and no unsaved-changes bar; tag filter counts equal DB counts (`preis-leistung` 1, `recommendation visibility` 1, `aktuell` 1, `rechtsschutz` 14) and per-prompt membership is correct for all 12 tag/prompt combinations; second visit leaves 30 prompts; browser console errors 0; web/worker error lines 0.

Gap recorded: the pre-Save steps (paste, "Add 3 Prompts", staged chips, unsaved bar, DB unchanged) were executed by the operator, not observed by the driver; the same steps were driver-verified on the rehearsal copy with the identical image IDs.

## Safety attestations

No direct push, bypass, or history rewrite; no upstream sync or unrelated scope; no migration, schema, service, dependency, secret, or cap change; no live provider calls in automated or rehearsal phases; no Docker reset/prune/data relocation; production volume never replaced, `down -v` only on the disposable rehearsal project; no secrets or full production prompt text in evidence; previous images remain available.
