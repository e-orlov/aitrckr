# LOC-01 German user location for OpenRouter web search — production closeout

Status: **PRODUCTION REAL-LIFE ACCEPTANCE PASS / CLOSED** 2026-09-11. Raw evidence (redacted request/response records, job/run snapshots, logs): operator-private `~/.elmo/loc-01-evidence/` (`pr-body.md`, `live/`, `images.md`, `image-build.log`, `rehearsal.md` + `rehearsal/`, `deploy-packet.md`, `cutover/`, `live-acceptance/`).

## What changed

Every web-enabled OpenRouter request — tracked prompt runs through `Provider.run()` and structured research through `runStructuredResearch()` — now declares OpenRouter's `openrouter:web_search` server tool with `engine: "native"` and a fixed searcher location `{ "type": "approximate", "country": "DE", "timezone": "Europe/Berlin" }`, plus `tool_choice: "required"` and `max_tool_calls: 1` (exactly one mandatory search per request, as the replaced plugin did). The deprecated `:online` model suffix and `plugins: [{ id: "web" }]` are no longer sent; the outbound model slug is bare (`openai/gpt-5.6-luna`, `openai/gpt-5-mini`). `SCRAPE_TARGETS` still uses `:online` as Elmo's web-search flag and is unchanged.

This is **search-result localization only**: the native provider search is told the searcher is in Germany. It is not IP spoofing, does not change the OpenRouter base URL or where data is processed (not EU data residency), and applies no city or region bias. No UI setting, environment variable, database field or migration was added.

## Identities

| Item | Value |
|---|---|
| Starting baseline | `25abb65d511fb53894164c0cd07e312076913e3c` (UI-R1 closeout; production source `039026ac`, images `g039026ac`) — verified at task start, no drift |
| Branch / worktree | `fix/loc-01-openrouter-de-user-location` in `../aitrckr-loc-01` (3 commits) |
| Feature PR | [#36](https://github.com/e-orlov/aitrckr/pull/36) — Build / Dependency License Audit / E2E Integration Tests / Scheduling Policy Verification / smoke 5/5; squash-merged |
| Application source | `94705764f2dc5faaebd9bc1271528b6a9e04e22b` — post-merge `main` workflows Build, E2E Tests, Deployment Smoke Tests, License Check 4/4 success; feature branch deleted |
| Files changed | `packages/lib/src/providers/registry/openrouter.ts`, `openrouter.test.ts`, `packages/config/src/scrape-targets.test.ts`, `packages/docs/content/docs/user-guide/providers.mdx`, `.changeset/openrouter-german-web-search-location.md` |
| Images (built once 2026-09-11T20:35–20:52Z from the clean detached worktree `../aitrckr-loc01-build` at the source commit, isolated config dir `%USERPROFILE%\.elmo-build`, project `elmo-build`; no `latest`) | `elmo-web:g94705764` `sha256:8df979f4098383697e5c1195769c0e0b2c75d0370248a3016640717a0eb4db17`; `elmo-worker:g94705764` `sha256:a54936a4fd912f58a6f3231365e3e7a35526903a228a3ba1352ed7012daaeb13`; `elmo-db-migrate:g94705764` `sha256:ea26f6858dc286777d6060024d1c9e39d2451aa9c8fc37c0f961f5dbbaa9ae3a`; never rebuilt; the same IDs ran in rehearsal, rollback → return, and production |
| PostgreSQL | `postgres:18-alpine` `sha256:d3e1620b530c…`, container not recreated (Up 2 days before and after) |
| Migration journal | **20 before and after** — no migration (diff touches nothing under `migrations/`); db-migrate exit 0 in rehearsal and production with nothing to apply |
| Rollback target | `g039026ac` trio (web `cb74417d25f3`, worker `12a1f1820e62`, db-migrate `568e841d8f8f`), on disk; image-only: `gen-prod-env.cjs %USERPROFILE%\.elmo g039026ac` + `docker compose up -d --no-build` (rehearsed) |
| Backups | rehearsal `elmo-prod-pre-loc01-20260911-202105.dump` 2,886,401 B sha256 `7c1c5b9366c30773efe5a27b52ab7cc5c5d41c1c7e1ea23afdfe7f25a5ac2e0c` (restored identically: 496 runs / 1,436 citations / journal 20 / digest `2e9de2e3…`); pre-cutover `elmo-prod-pre-loc01-cutover-20260911-211635.dump` 2,910,147 B sha256 `e324954cfd1815de29e29dfbc6b7d69feb58c3b934b4975e97046838f82879f3` (500 runs / 1,446 citations / journal 20 / digest `8b7308ca…`, 31 TABLE DATA entries) |
| Pre-cutover revalidation (21:15Z) | `origin/main == 94705764`; candidate IDs equal the packet; production on the exact `g039026ac` trio, restarts 0, HTTP 200, `.env` `5155578153d44336…`, `SCRAPE_TARGETS=chatgpt:openrouter:openai/gpt-5.6-luna:online` present once, journal 20, 33 chain jobs; three natural paid jobs due 21:15:48–57Z were allowed to finish first (runs 497 → 500, 0 errors) |
| Cutover | 2026-09-11T21:17:01.2Z `gen-prod-env.cjs … g94705764` (`.env` byte-identical; `elmo.yaml` diff = exactly the three `image:` lines `g039026ac → g94705764`) + `docker compose up -d --no-build`; db-migrate exit 0; web HTTP 200 at 21:17:18.0Z (**≈17 s**, 6 non-200 probe seconds); web/worker recreated, postgres untouched |
| Post-cutover state | web `8df979f4…` / worker `a54936a4…` running, restarts 0; handlers registered; 33 `process-prompt` chain jobs `created` for 33 prompts, next 21:53:23Z unchanged; journal 20/20; `.env` unchanged |

## V-Model traceability

| Req | Evidence |
|---|---|
| LOC-F-001/002/003/004 exact `user_location` under `tools[].parameters`, `engine: native`, on tracked and structured requests | `openrouter.test.ts` deep-equality (`expectWebSearchContract`) + live pre-merge calls (payload captured from the real `fetch`) |
| LOC-F-005 disabled calls carry nothing web-related | raw-JSON negative assertions (`expectNoWebSearch`) for `run()` and `runStructuredResearch()` |
| LOC-F-006 no mixing with `:online`/plugins | exact key-set assertion; `plugins` absent; model never ends in `:online` |
| LOC-F-007 one search per prompt | `tool_choice: required` + `max_tool_calls: 1`; live `web_search_requests = 1` in both pre-merge calls and in the production forced run |
| LOC-F-008 models unchanged | unit assertions; production run recorded `openai/gpt-5.6-luna`; structured research `openai/gpt-5-mini` |
| LOC-F-009 extraction / citations / version / cap / headers / errors intact | regression tests; production run: 3,405-char extracted text, 7 citations persisted |
| LOC-F-010 `SCRAPE_TARGETS …:online` valid | `scrape-targets.test.ts`; production `.env` unchanged and runs succeed |
| LOC-NF-001/002/003 | no migration; no secret in diff/artifacts (error-path tests assert it); scoped diff (5 files) |
| LOC-OPS-001/002/003 | immutable `g94705764` built once; forced run below; image-only rollback rehearsed |

## Bounded live contract validation (pre-merge, 2 paid calls, 0 retries, ≈$0.029)

| | tracked `run()` | `runStructuredResearch()` |
|---|---|---|
| time (UTC) | 20:14:10–23 | 20:14:36–20:15:02 |
| HTTP / finish | 200 / `stop` | 200 / `stop` |
| model / upstream | `openai/gpt-5.6-luna` / OpenAI | `openai/gpt-5-mini` / OpenAI |
| answer | 973 chars | 527 chars strict JSON, Zod parse OK |
| `url_citation` | 2 | 3 |
| `usage.server_tool_use_details.web_search_requests` | 1 | 1 |
| cost | $0.0134 | $0.0153 |

Note: OpenRouter returns the search count under `usage.server_tool_use_details` (the docs page names it `server_tool_use`). `tool_choice: "required"` with a server tool is not explicitly documented; the live calls and the production run prove the combination is accepted and yields exactly one search with a final answer and citations.

## Rehearsal (isolated, stub provider) — PASS

Project `elmo-loc01-rehearsal` on the restored production dump (loopback 1516/5434, own volume, fresh secrets, `SCRAPE_TARGETS=stub:stub`): candidate up (migrate exit 0, journal 20 → 20, web 200, worker ready, 0 restarts/errors); image content check (worker `openrouter.ts` carries the server-tool contract, no `plugins`; production worker at the time had 0 occurrences); forced-run mechanism (admin `retryJobFn` + `forceDue: true` from the operator's existing session) → HTTP 200 → job `retry_limit 0` completed in 1.5 s → exactly one new run, chain preserved; rollback to `g039026ac` and return to `g94705764` PASS; `down -v` on the rehearsal project only.

## Real-life production acceptance (21:18Z) — PASS, exactly one paid call

Forced run via the existing admin `retryJobFn` server function with `forceDue: true` (audit line `Force-run: prompt 4932f972… bypassing the cadence gate (operator-triggered)`), prompt `4932f972-7f78-46e4-a714-28c68e043993` (brand `arag`):

| Check | Result |
|---|---|
| request accepted exactly once | HTTP 200 `Triggered immediate job…`; 1 forced job total |
| job | `3a918551-850b-473c-b915-370356a85937`, `retry_limit 0`, created 21:18:22.34Z, started 21:18:23.95Z, **completed** 21:18:40.92Z, retry_count 0 |
| new `prompt_runs` row | exactly one: `18dadae8-609b-45b8-a150-e9e84cf4e7be` (500 → 501 runs) |
| provider / version / web search | `openrouter` / `openai/gpt-5.6-luna` / `web_search_enabled = true` |
| answer | `choices[0].message.content` 3,405 chars (raw 15,127 chars), `finish_reason stop`, response model `openai/gpt-5.6-luna`, upstream OpenAI |
| citations | 7 annotations → 7 `citations` rows persisted (1,446 → 1,453; domains adac.de, check24.de, verbraucherzentrale.de, verivox.de) |
| `usage.server_tool_use_details.web_search_requests` | **1** (cost $0.0130) |
| duplicates | none — 1 job, 1 run; canonical chain job `7a82ba06…` preserved (`Next run … existing`) |
| worker log | 0 error / 400 / tool / location / timeout / parse lines |
| health | web/worker restarts 0, HTTP 200, journal 20/20, `.env` sha unchanged, images == approved candidate, 33 chain jobs, next natural run 21:53:23Z unchanged |

The exact serialized payload (unit oracle + captured live request) proves the German `user_location` configuration; the completed production run proves end-to-end operability. Answer content is not treated as proof of location.

## Scope declarations

Unchanged: tracked model (`openai/gpt-5.6-luna`), research model (`openai/gpt-5-mini`), provider order, other providers, `SCRAPE_TARGETS`, scheduling/retries/timeouts/`RUNS_PER_PROMPT`, citation metrics, OpenRouter base URL. No city/region, no UI/env/DB setting, no migration, no backfill.
