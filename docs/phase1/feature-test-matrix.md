# Phase 1 — feature-test matrix (local mode, fork @ b3bea1e)

Built from the runtime inventory (routes, `packages/deployment` local flags, OpenAPI, schema, pg-boss queues, UI, existing tests, changelog) executed 2026-08-29 on the seeded `aitrckr-test` stack (web 127.0.0.1:3999). Statuses reference evidence in baseline-report.md (suite runs) and this file (gap tests). Requirement anchors: REQ-FUNC-001/002; group-specific REQ-* noted per row.

Local flags in effect: readOnly=false, canCreateBrands=true, selfServeSignup=false (single bootstrap signup), billing=false, reportGeneration=true, teamInvites=false, showOptimizeButton=false.

| # | MP §7.G group | Feature surface | Test ID(s) | Evidence source | Status |
|---|---|---|---|---|---|
| 1 | Landing/auth | bootstrap signup (single), login/logout, session guard, second-signup rejection, no Google/forgot-password in local | ST-FUNC-001 | `local-deployment.spec.ts` + `access-control.spec.ts` (39/39 run) | PASS |
| 1b | Landing/auth | forgot/reset-password pages redirect to login in local; /choose-plan redirects to /app | ST-FUNC-001b | phase1-coverage.spec.ts | PASS |
| 2 | Brand | brand read/update (name, website, domains, aliases); brand switching (2 seeded tenants); create-brand link+form | ST-FUNC-002 | overview.spec + local-deployment.spec + Bruno brands/* (10) | PASS |
| 2b | Brand | create-brand SUBMIT flow + onboarding wizard drive-through | ST-FUNC-002b | deferred: submit provisions org+brand and triggers analyze-brand → exercised at stage I on synthetic production-like stack (checkpoint rehearsal) | PLANNED (stage I) |
| 3 | Competitors | CRUD via API; UI settings page renders seeded competitors | ST-FUNC-003 | Bruno competitors/* (10); phase1-coverage.spec.ts (UI) | PASS |
| 4 | Prompts | CRUD, tags, enable/disable via API; UI editor renders; pagination | ST-FUNC-004 | Bruno prompts/* (16); phase1-coverage.spec.ts (UI) | PASS |
| 4b | Prompts | bulk paste / bulk select UI interactions, unsaved-changes bar | ST-FUNC-004b | unit `bulk-prompts.test.ts`; UI interaction untested upstream — recorded gap, exercised manually at stage I rehearsal | PLANNED (stage I) |
| 5 | Prompt Wizard | website analysis → suggestions (no persist) via API with stub LLM | ST-FUNC-005 | Bruno tools/analyze (3 cases, stub target) | PASS (stub) |
| 6 | Provider settings | LLMs settings page renders platform groups; SCRAPE_TARGETS parsing/validation | ST-FUNC-006 | phase1-coverage.spec.ts (UI); unit scrape-targets/config tests (486 green) | PASS |
| 6b | Provider settings | masked credential entry in UI | — | NOT AVAILABLE in local build: no in-app provider-credential UI exists (secrets table is CLI-managed). OpenRouter key therefore goes into production `.env` (MP §7.H.5 fallback path) | NOT APPLICABLE (feature absent) |
| 7 | Worker/jobs | queue creation, submit→process (stub), volume contract RUNS_PER_PROMPT, duplicate-firing no-op | ST-FUNC-007 | worker.spec.ts (1/1); verify-scheduling.ts logic | PASS (stub) |
| 7b | Worker/jobs | generate-report end-to-end (worker actually generates) | ST-FUNC-007b | phase1-coverage.spec.ts report-generation test (stub, worker up) | see run log below |
| 7c | Worker/jobs | failure/retry states, restart recovery, no duplicate completed evaluation | OT-RES-* | stage J crash/idempotency suite | PLANNED (stage J) |
| 8 | Raw answer/evaluation | prompt_runs rows with model/version/timestamps; mention detection fields | ST-FUNC-008 | worker.spec.ts DB assertions (version=stub); prompt-details.spec tabs | PASS (stub) |
| 9 | Sentiment | existing behavior only (Phase 2 backlog) — regression baseline via unit tests | CT-QUAL-001 | unit suite green | PASS (baseline only; REQ-SCOPE-002) |
| 10 | Citations | citations page, filters, drill-down on seeded fixtures | ST-FUNC-010 | citations.spec.ts (4) + Bruno snapshot | PASS |
| 11 | Query fan-out | page renders tabs Prompt Fan-Out/Query Words/Query Visibility on seeded data | ST-FUNC-011 | phase1-coverage.spec.ts; unit fanout-analysis | PASS (fixtures; live provider data at stage H) |
| 12 | Dashboard/visibility | overview cards, visibility page, filters, sort | ST-FUNC-012 | overview.spec (6) + visibility.spec (4) | PASS |
| 13 | Share of voice | SoV page renders leaderboard/donut/timeline on seeded fixtures | ST-FUNC-013 | phase1-coverage.spec.ts | PASS |
| 14 | Trends/time series | 30-day trend bands on deterministic seeded runs; UI vs SQL cross-check | ST-FUNC-014 | seeded fixtures + overview/visibility specs; deeper SQL cross-check at stage I | PASS (basic); PLANNED (SQL cross-check, stage I) |
| 15 | Opportunities | page renders (stub LLM generation path) | ST-FUNC-015 | phase1-coverage.spec.ts | see run log below |
| 16 | Reports | create/list/poll via API; UI list; render page; background generation | ST-FUNC-016 | Bruno reports/* (6); phase1-coverage.spec.ts (render page + generation) | see run log below |
| 17 | REST API /api/v1 | all 19 operations: auth, validation, pagination (prompts), safe errors | ST-FUNC-017 | Bruno 54 req/116 asserts — 19/19 operations covered | PASS |
| 17b | REST API | pagination for brands/competitors/reports (upstream test gap) | ST-FUNC-017b | phase1-coverage API checks | see run log below |
| 18 | Settings | brand/competitors/prompts/llms pages; members+billing correctly absent | ST-FUNC-018 | local-deployment.spec (members redirect) + phase1-coverage.spec.ts | PASS |
| 19 | Accessibility/browser | keyboard nav, labels, console errors on main flows | ST-FUNC-019 | partial via Playwright runs (no console-error assertions upstream); targeted smoke at stage I | PLANNED (stage I) |
| 20 | Persistence | data across container/Docker/Windows restart | OT-DATA-* | stage J/K suites | PLANNED (stage J/K) |
| 21 | Admin | /admin brands, /admin/workflows (queue stats), /admin/tools | ST-FUNC-021 | overview.spec (/admin) + phase1-coverage.spec.ts | PASS |
| 22 | Health | /api/setup-status returns DB+migrations ok | ST-FUNC-022 | phase1-coverage API check | see run log below |

NOT APPLICABLE by accepted architecture (matrix scope register): billing/Stripe, team invites/members, SSO/Auth0, cloud/whitelabel/demo modes, real consumer ChatGPT scraping (REQ-SCOPE-001), scraper providers (Cloro/BrightData/Oxylabs/Olostep/DataForSEO) — NOT CONFIGURED BY DESIGN.

Known upstream coverage gaps recorded for honesty (not Phase 1 defects): UI interactions for bulk prompt ops/save bar, analyze-brand queue e2e, RLS direct assertion, graceful-shutdown drain, `boss-client.ts` vs worker queue-creation drift. Tracked here; none blocks local-mode operation.

## Gap-test run log (phase1-coverage)

Spec: `e2e/tests/local/phase1-coverage.spec.ts` (18 tests), run against seeded aitrckr-test stack, BASE_URL=http://localhost:3999.

- 2026-08-29/30 iterations: 2 selector fixes (SoV leaderboard is an empty state on brand-only seeded mentions — page itself renders with h1; admin/tools input lacks the textbox role — asserted the "Analyze brand" button) and 2 test-defect fixes in the report test (poll timeout 120s → 300s: the pipeline fetches the target website for real even with the stub LLM; response field is `reportId`, not `id`). All were defects in the new tests, not in the app.
- Final: **full local project 56/56 PASS (22.0s)** — 38 pre-existing + 18 new, including `worker generates a report end-to-end` (stub provider; report row reached status=completed, progress=100, verified in DB and via GET /api/v1/reports/{id}).
- Rows 1b, 3, 4, 6, 11, 13, 15, 16, 17b, 18, 21, 22 above → **PASS** on this evidence.
- Remaining PLANNED items: 2b/4b/19 (stage I rehearsal), 7c/20 (stage J/K), 14 SQL cross-check (stage I). REQ-FUNC-001 (inventory completeness) → PASS; REQ-FUNC-002 stays open until those close.
