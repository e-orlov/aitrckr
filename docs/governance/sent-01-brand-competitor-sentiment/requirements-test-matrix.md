# SENT-01 Brand & Competitor Sentiment — requirements and test traceability

Executable contract frozen at CP1 (2026-09-11) before implementation. Two deliverables ship
in order: **SENT-R0** (competitor identity preservation — **CLOSED 2026-09-12**, see
`docs/governance/sent-r0-competitor-identity-closeout.md`) and **SENT-R1/R2** (sentiment truth
foundation + analytics page). Status is updated as each PR lands.

## Frozen versions and constants

| Item | Value |
|---|---|
| Competitor lifecycle | `competitors.active boolean not null default true`, `competitors.removed_at timestamptz null`, `competitors.previous_names text[] not null default '{}'`, index `competitors_brand_id_active_idx (brand_id, active)` |
| Mention detector version | `sent-detector-v1` |
| Sentiment classifier version | `sent-classifier-v1` |
| Aspect taxonomy version | `sent-aspects-v1` — canonical keys `price`, `coverage`, `service`, `other` |
| Classifier model/path | existing `Provider.runStructuredResearch({ webSearch: true })` → OpenRouter `DEFAULT_RESEARCH_MODEL = openai/gpt-5-mini`, strict JSON schema; web search through whatever the shared OpenRouter path sends on `main` (since LOC-01 #36: `openrouter:web_search` server tool, `engine: native`, German `user_location`, one mandatory search); no override, no Luna; validated by one bounded canary at CP6 |
| Categories | Positive (51–100), Negative (0–49), Neutral (=50, no evaluation), Mixed (=50, both evaluations) |
| Queue | new exclusive pg-boss queue `classify-sentiment`, singleton key `sentiment:<promptRunId>:<classifierVersion>`, `localConcurrency: 1`, retryLimit 3 / retryDelay 60 / backoff, expiry 900 s |
| Dependencies added | none |

## Active vs historical competitor semantics (SENT-R0)

"Active" = presently tracked (`active = true`). "Historical" = every row regardless of status.
A removed competitor keeps its UUID, its row and every historical relationship; it disappears
from current product surfaces.

| Consumer | Semantics | Site |
|---|---|---|
| Settings roster (`getCompetitors`), brand hydration, brand layout loader | active | `apps/web/src/server/brands.ts`, `routes/_authed/app/org/$org/brand/$brand.tsx` |
| Worker mention detection for new runs | active | `apps/worker/src/jobs/process-prompt.ts` |
| Competitor cap | active | `packages/lib/src/entitlements/guards.ts` |
| Visibility, Competitive AI Visibility, Share of Voice rosters | active | `server/visibility.ts`, `server/competitive-visibility-load.ts`, `server/prompts.ts` |
| Citations / dashboard / opportunities / prompt snapshot competitor-domain sets | active | `server/citations.ts`, `server/dashboard.ts`, `server/opportunities.ts`, `routes/api/v1/prompts/$promptId/snapshot.ts` |
| Onboarding dedupe | active | `server/onboarding-core.ts` |
| Public API list / single GET / PATCH / DELETE | active (DELETE = soft removal; inactive rows are 404) | `routes/api/v1/competitors/**` |
| Source-classification backfill exclusion context | active | `apps/worker/scripts/source-classification-backfill.ts` |
| `addDomainToCompetitorFn` | active | `server/brands.ts` |
| Reactivation match inside the roster save | historical (narrow, inside the transaction only) | `packages/lib/src/db/competitors.ts` |
| Sentiment historical reconciliation / backfill (R1) | historical | R1 |

Roster save contract (`updateCompetitors`): one transaction, rows locked `FOR UPDATE`;
submitted `id`s must belong to the brand; entries with an `id` update in place (an inactive
row is reactivated); entries without an `id` reuse exactly one unclaimed row that shares a
normalized domain (else insert); two or more candidates, or one candidate claimed twice,
reject the whole save; active rows omitted from the submission become inactive with
`removed_at = now()`; a rename appends the old name to `previous_names`; nothing is
physically deleted; the cap counts the resulting active roster.

Rollback note: old application images still bulk-delete on save. While production runs an
older image after this migration, **competitor settings must not be edited**.

## Canonical sentiment formulas (SENT-R1/R2)

`T` eligible responses; `M_e` distinct responses mentioning `e`; `C_e` classified among them;
`P/U/X/N` Positive/Neutral/Mixed/Negative among `C_e`; `s_i` scores.

```
SentimentAmongMentions = sum(s_i)/C   (null when C = 0)
MentionVisibility = M/T·100   PositiveVisibility = P/T·100   NegativeVisibility = N/T·100
PositiveMix = P/C·100  NeutralMix = U/C·100  MixedMix = X/C·100  NegativeMix = N/C·100
AnalysisCoverage = C/M·100
```

Full precision internally, round once at display. `T = 0` → empty state. No signed net
sentiment, no sentiment×visibility composite. Chart roster = own brand + up to six active
competitors by mention count desc, then normalized name, then id; frozen for the whole trend.
Default leaderboard sort: sentiment desc, nulls last, then classified mentions desc, name, id.
Buckets: daily for month-sized windows (≤ 35 days, so a calendar month stays daily), weekly ≤ 180 days, monthly beyond; gaps stay `null`.

Acceptance fixture (encoded in `UT-SNT-002`): T=10; A: scores 100P, 80P, 50 Mixed, 40N, 30N →
60 / 50 % / 20 % / 20 % / mix 40-0-20-40 / coverage 100 %; B: one 90P → 90 / 10 %.

## Traceability — SENT-R0

| Test ID | Required proof | Where | Status |
|---|---|---|---|
| UT-ID-001 | Diff/upsert classification: insert / update / deactivate / reactivate / unchanged | `packages/lib/src/db/__tests__/competitors.test.ts` | PASS (PR #37) |
| UT-ID-002 | Normalization, duplicate domain, ambiguous reactivation, unknown/cross-brand id rejection | same | PASS (PR #37) |
| IT-ID-001 | Populated migration preserves every pre-migration UUID and marks rows active | seeded test DB, restored production copy and production: digest identical, all active | PASS (2026-09-12) |
| IT-ID-002 | No-op settings save preserves ids and business values | same | PASS (PR #37) |
| IT-ID-003 | Soft removal hides current roster but retains the row and FK validity | same | PASS (PR #37) |
| IT-ID-004 | Public competitor API no longer physically deletes | `routes/api/v1/competitors/$competitorId.ts` + Bruno collection 60/60 | PASS (PR #37) |
| REG-ID-001 | Existing Visibility, SoV, Citations, Opportunities, onboarding, prompt processing, caps and settings suites pass with active semantics | `pnpm test`, Storybook, Playwright `local` | PASS (unit 1353, Storybook 161, Playwright local 114, Bruno 126 assertions) |
| E2E-ID-001 | Real settings UI save/reload preserves ids and visible roster | `e2e/tests/local/competitor-identity.spec.ts` | PASS (local + CI; production acceptance via the page-bound server function, closeout doc) |

## Traceability — SENT-R1/R2

Implemented in the second PR (`feat/sent-01-brand-competitor-sentiment`). Tables: `sentiment_detections` (run-level,
detector-versioned receipts), `prompt_run_entity_mentions`, `sentiment_analyses`, `sentiment_observations`,
`sentiment_aspect_observations` (migration `0021_sentiment_foundation`, journal 21 → 22; every row cascades with its
prompt run, competitor references stay restrictive). Library `packages/lib/src/sentiment/`, worker queue
`classify-sentiment` (`localConcurrency: 1`, atomic job-side claim), CLI `pnpm -C apps/worker backfill:sentiment
{mentions|sentiment}`, page `/app/org/$org/brand/$brand/sentiment`.

Corrective round 1 (SENTIMENT MERGE GO withheld → B1–B8): provider lock (B1), detection receipts (B2), atomic claim (B3),
aspect sample metrics (B4), SQL-bounded evidence (B5), cascade deletion (B6), raw-offset evidence + Mixed polarity (B7),
input-hash freshness (B8). Corrective round 2 (withheld again → C1–C6): superseded/current mention lifecycle (C1),
claim-generation fence + job abort signal through to the OpenRouter fetch (C2), per-run source cap enforced in SQL (C3),
whole-string NFKC with grapheme-aligned raw offsets (C4), sanitized error persistence/throw/capture (C5), one
classifier+taxonomy eligibility predicate shared by coverage and metrics (C6). Rows touched by a round were reset from
PASS and re-proven with the new tests; counts below are the current ones.

Canary-safety round (PAID CANARY GO withheld → D1–D5, PR #42): both OpenRouter web-search usage shapes with strict
numeric validation and an explicit conflict state (D1), a frozen canary contract enforced before the call (preflight,
no request on any mismatch) and after it (verdict with stable codes, non-zero exit) (D2), one owned `AbortController`
shared by deadline and watchdog plus a process-level supervisor that kills the child tree (D3), single paid-call
attribution when the write fails after the answer (D4), a committed contract-driven driver with the production
constants kept in operator evidence (D5). Corrective round 3 (MERGE GO withheld again → E1–E4): the post-call
contract is decided before persistence (a rejected answer ends as `failed`/`canary-contract`, never `completed`,
with the paid call attributed once) (E1); the exact classifier input and outbound prompt are frozen in the contract
and re-checked at the provider boundary, closing the preflight→call window (E2); `run` requires the authorized
`--contract-sha256`, verified by supervisor and child over the raw file bytes (E3); child mode is internal to the
supervisor through a one-time token (E4). CT-SNT-003 and OPS-SNT-001 were reset from PASS and re-proven.

Corrective round 4 (PAID CANARY GO withheld → F1, task SENT-CANDIDATE-ORDER): the candidate order followed the
mention rows' `ORDER BY detected_at, id`; one backfill transaction gives every row the same timestamp, so the random
row UUID decided the outbound prompt and its digest, which therefore differed between two databases holding the same
data (RED: `candidate-order.test.ts` 6 failures, IT-SNT-022 raw contract bytes differ). Now one comparator
(`compareSentimentEntities`: own brand first, then competitors by immutable key in code-unit order) is applied by the
detector, `loadMentions`, `candidatesFromMentions`, `buildSentimentPrompt`, canary `inspect`/contract parsing,
preflight and the classifier-boundary recheck; `sentimentInputHash` is unchanged for the same logical input. The
canary additionally refuses a run that already carries a completed analysis or observations (`run-already-classified`)
and `inspect` reports the run state on stderr, so the frozen run never needs a manual reset.
Round G1/G2 (same PR, MERGE GO withheld): a run is pristine only when it was never attempted — no analysis row, or
`pending` with zero attempts and zero observations (`isPristineCanaryRun`, shared by `inspectSentimentCanaryRunState`
and the preflight guard). A failed attempt without observations is NOT eligible any more: `run-not-pristine`
(detail `status/attempts/observations`) refuses before the provider boundary, so one authorization buys exactly one
provider call (RED: `canary-single-attempt.test.ts` 8 failures, commit a0814211). Contract `entities[]` must be unique by
`entityType:key` at schema level (RED commit 56cb458f). Round G3: preflight is a read; two canaries could pass it
together and the worker's ordinary claim (which accepts `failed`) let the second one reach the provider (RED:
`canary-atomic-claim.test.ts`, commit 1969250c — 2 provider calls, attempts 2, 2 usage events). The call is now granted
by a canary-only atomic claim: one UPDATE that matches only `status = pending AND attempts = 0 AND NOT EXISTS
(observation)`; a loser writes nothing and refuses with `run-state-drift` (the row's status). The worker's claim
semantics (retry after failure, stale-processing recovery, reclassification of finished rows) are unchanged.

| Test ID | Required proof | Where | Status |
|---|---|---|---|
| UT-SNT-001 | Score/category boundaries, Mixed vs Neutral, null behaviour, round-once | `packages/lib/src/sentiment/__tests__/metrics.test.ts` | PASS |
| UT-SNT-002 | Canonical T/M/C/P/U/X/N formulas using the mandated fixture | same (`UT-SNT-002 canonical fixture`) + Storybook `Default` + integration `IT-SNT-006` | PASS |
| UT-SNT-003 | Entity detection with aliases, domains, Unicode boundaries, repetition, citation-only exclusion | `__tests__/detector.test.ts` | PASS |
| UT-SNT-004 | Entity-targeted comparisons, negations and multi-entity attribution | golden corpus critical cases validated through `classifySentiment` | PASS (reference labels); live agreement gated at CP6 |
| UT-SNT-005 | Versioned aspect normalization and overall/aspect divergence | `types.ts` taxonomy `sent-aspects-v1`, `__tests__/classifier.test.ts`, `IT-SNT-006` aspect view, golden g04/g14/g34 | PASS |
| UT-SNT-006 | Evidence matching/offset validation and Mixed dual evidence | `__tests__/classifier.test.ts` (14 tests): whole-string NFKC — decomposed body vs composed quote and the reverse, stacked marks, compatibility (①, ﬁ, Ａ) — resolve to exact raw start/end and slice; `normalizeIndexed(x).text === x.normalize("NFKC").toLowerCase()`; per-excerpt polarity; Mixed needs one positive + one negative (two same-polarity excerpts fail) | PASS (B7, C4) |
| UT-SNT-007 | Deterministic top/bottom non-overlap and tie-breaks | `__tests__/metrics.test.ts` (`extremesAllocation`, code-unit tie-breaks) + `IT-SNT-007` + E2E-SNT-003 | PASS (B5 re-proven) |
| UT-SNT-008 | Adaptive buckets, null gaps, Top-6 roster and stable sorting | `__tests__/metrics.test.ts` + `IT-SNT-006` series | PASS |
| UT-SNT-009 | Selected-aspect sample metrics: S vs M vs C, `S/T` visibility, no Partial from an absent aspect | `__tests__/metrics.test.ts` (`B4` cases), Storybook `PriceAspect`, `IT-SNT-006` "B4" case, E2E-SNT-002 Price view | PASS (B4) |
| UT-SNT-010 | Input hash covers normalized body and every candidate identity in stable order | `__tests__/classifier.test.ts` (`B8`) | PASS (B8) |
| GOLD-SNT-001 | ≥40 synthetic labelled DE/EN cases; reference labels validate 100 %; evaluator gates | `golden/corpus.ts` (42 cases, 23 DE / 19 EN, 14 critical, polarity-labelled evidence), `golden/evaluate.ts`, `__tests__/golden.test.ts`; live: `pnpm --filter @workspace/lib eval:sentiment-golden -- --live --max N` (paid, gated) | PASS offline; live at CP6 |
| CT-SNT-001 | Tables, checks, unique constraints, RLS, indexes, cascades, lifecycle columns | `apps/worker/scripts/verify-sentiment-db.ts` (34 checks on real Postgres: receipt checks, 8 concurrent `claimAnalysis` → 1 winner with generation 1, stale-generation write refused / current accepted, superseded vs deleted mention rows, cascade on run delete, competitor FK restrictive) | PASS (B2/B3/B6/C1/C2) |
| CT-SNT-002 | Sentiment resolves OpenRouter `openai/gpt-5-mini`, strict schema, web-search server tool; ignores `ONBOARDING_LLM_TARGET` and direct OpenAI/Anthropic keys | `__tests__/provider.test.ts` (all keys configured → OpenRouter; stubbed fetch body asserted), `classifier.test.ts` model-mismatch guard | PASS (B1) |
| IT-SNT-001 | Job success, no-mention, invalid output, evidence failure, retry, stale version, lost claim, claim-lost on every terminal path, abort signal forwarded, sanitized failure | `__tests__/job.test.ts` (24 tests) + `__tests__/provider.test.ts` (5: signal reaches the OpenRouter `fetch` and aborts it) + stub-runtime worker run (fails closed without `OPENROUTER_API_KEY`; attempt attributed to openrouter / gpt-5-mini) | PASS (C2/C5) |
| IT-SNT-002 | Queue policy, singleton dedupe, DB idempotency and concurrency race | `verify-sentiment-db.ts` (8 concurrent sends → 1 accepted; 8 concurrent `persistDetection` → 1 receipt + 1 row per entity; 8 concurrent claims → 1 winner) | PASS |
| IT-SNT-003 | New prompt run remains successful if supplemental enqueue fails; repair recovers it | `__tests__/job.test.ts` (receipt written for no-answer/no-mentions, enqueue never throws), `job.ts` repair path | PASS |
| IT-SNT-004 | Receipt-based inventory/backfill: dry → apply → dry for mention, zero-mention and unextractable runs; detector-version change | `sentiment-pipeline.integration.test.ts` "IT-SNT-004" + CLI dry → apply → dry on the seeded DB (written 49 → alreadyCurrent 49) | PASS (B2) |
| IT-SNT-005 | Paid enqueue limit counts accepted jobs and never calls provider in CLI | CLI `sentiment --enqueue --limit 1`: accepted 1; worker fails closed in the stub runtime, 0 calls | PASS |
| IT-SNT-006 | Overview auth/tenancy, filters, formulas, all active rows, inactive exclusion, coverage from receipts, aspect sample, no writes | `sentiment-overview.integration.test.ts` | PASS (B2/B4) |
| IT-SNT-007 | Evidence bounded in SQL (COUNT + ORDER BY/LIMIT), non-overlap allocation, tie-breaks, ≤20 run fetch, citations deduplicated and capped per run in SQL, EXPLAIN | `sentiment-pipeline.integration.test.ts` "IT-SNT-007" (3,002 current observations; SQL oracle with the mention/taxonomy joins; plan = `Limit` over `Index Scan Backward … brand_entity_score_idx`, `evidence-explain.txt`) + "IT-SNT-015" (26 citations, 25 distinct → `loadRunSources` returns exactly 8 rows from the database, citation order) + `sentiment-overview.integration.test.ts` | PASS (B5, C3) |
| IT-SNT-008 | Run-specific prompt deep link authorization and pagination-independent retrieval; reduced motion respected | `getPromptRunFn` + E2E-SNT-003 / "deep link rejects a run that belongs to another prompt"; `prefers-reduced-motion` → `behavior: auto` | PASS |
| IT-SNT-009 | Empty and populated migrations plus rollback-compatible old app paths | 0021 (regenerated, unmerged) applied on the empty chain 0000→0021 and the seeded DB; additive tables only, cascades make the old deletion sequence safe | PASS (local); rehearsal at CP5 |
| IT-SNT-010 | Atomic job-side claim: N simultaneous `runSentimentJob` + barrier → 1 provider call, 1 observation set, 1 usage event; abandoned claim recovery; sanitized failed attempt | `sentiment-pipeline.integration.test.ts` "IT-SNT-010" (6 concurrent, real Postgres; failure row/thrown error contain code/status/provider only — no key, header, response body or answer text) | PASS (B3, C5) |
| IT-SNT-013 | Claim-generation fence: A claims, lease made stale, B claims and completes, A resolves late (success and failure variants) — B's status and observations intact; stale `markAnalysis` (no_mentions/failed) refused, stale `persistClassification` → `ClaimLostError` | `sentiment-pipeline.integration.test.ts` "IT-SNT-013" (3 tests, real Postgres, no waiting) | PASS (C2) |
| IT-SNT-014 | Superseded mention lifecycle: alias-only detection → classified → alias removed → backfill apply → receipt `no_mentions`, `loadMentions()` empty, dry run writes 0, observation retained but excluded from overview/evidence, no re-enqueue and no call; re-adding the alias reactivates the same row | `sentiment-pipeline.integration.test.ts` "IT-SNT-014" | PASS (C1) |
| IT-SNT-016 | Coverage and metrics share the eligibility contract: completed analysis under an old taxonomy contributes to neither (counted as pending work); the same row under the current taxonomy contributes to both | `sentiment-pipeline.integration.test.ts` "IT-SNT-016" | PASS (C6) |
| IT-SNT-017 | The Sentry wrapper captures exactly the sanitized job error (no key/header/body/answer; code, HTTP status, provider present; no `cause`) | `apps/worker/src/__tests__/sentry-wrap.test.ts` (2 tests, `node --test`) | PASS (C5) |
| IT-SNT-011 | Hash/taxonomy freshness: alias edit and newly detected competitor become eligible and are reclassified once; taxonomy mismatch never current | `sentiment-pipeline.integration.test.ts` "IT-SNT-011" | PASS (B8) |
| IT-SNT-012 | Prompt DELETE with a full sentiment graph leaves no orphans; competitor cannot be hard-deleted | `sentiment-pipeline.integration.test.ts` "IT-SNT-012" (exact handler sequence) + `e2e/tests/local/sentiment.spec.ts` "B6" (real `DELETE /api/v1/prompts/:id`) | PASS (B6) |
| UT-SNT-011 | OpenRouter usage: documented `server_tool_use` and observed `server_tool_use_details` counters, agreement, conflict → `null` + `webSearchRequestsConflict`; counts only finite non-negative integers, cost only finite non-negative; strings/NaN/±Infinity/negative/fractional → `null`; no other payload field retained | `packages/lib/src/providers/registry/openrouter.test.ts` ("parseOpenRouterUsage web-search counter", "numeric validation") | PASS (D1) |
| CT-SNT-003 | Canary contract: frozen run/prompt/brand ids, answer-body SHA-256, exact entity set, classifier-input and prompt digests, classifier/taxonomy versions, provider/model; preflight refuses run-not-found, prompt/brand mismatch, body hash mismatch, unextractable body, entity set mismatch (missing/extra/type), unknown entity, version/provider/model drift — without any provider call; verdict requires 1 attempt, 1 provider call, request `openai/gpt-5-mini` + web search + `max_tool_calls 1` + `max_tokens 8000`, usage present, `webSearchRequests === 1` (unknown/conflict/0/>1 rejected), `costUsd` valid and ≤ 0.10, `outputTokens` valid and ≤ 8000, exact entity keys; provider error, deadline, watchdog, unconfigured provider, non-classifying outcome rejected | `packages/lib/src/sentiment/__tests__/canary.test.ts` (61 tests) | PASS (D2, re-proven E1/E2) |
| IT-SNT-019 | One `AbortController` per canary: request deadline aborts the provider fetch (`TimeoutError`), watchdog aborts the same signal and ends the invocation; a provider that ignores the abort and answers late is attributed once as paid, never written (persist refuses under the aborted signal), never re-sent | `canary.test.ts` ("canary deadline and watchdog share one abort signal") | PASS (D3) |
| IT-SNT-020 | Process-level supervisor: a child that ignores termination and spawns a grandchild is killed as a tree within the watchdog; parent returns before the late work; no late marker, no second provider-call marker, grandchild gone; accepting/rejecting exits and spawn errors reported | `apps/worker/src/__tests__/sentiment-canary-supervisor.test.ts` (3 tests, `node --test`, fixture `stubborn-canary-child.mjs`) | PASS (D3) |
| IT-SNT-021 | E1 RED→GREEN: with the verdict decided after `persistClassification`, a rejected answer left a `completed` analysis and observations (RED: 7 gate tests failed on `persist not called`, commit cc239d15); now the gate runs inside the persistence boundary — usage missing, count unknown/conflict/0/>1, cost missing/invalid/>0.10, output tokens missing/invalid/>8000, request unverified/drift, entity-key mismatch → `persist` never called, analysis `failed`/`canary-contract`, one paid-success usage event with `actualCostUsd`, no `_failed` event, original reasons in the report; accept path persists exactly once | `canary.test.ts` ("E1", 9 tests) + `sentiment-pipeline.integration.test.ts` "IT-SNT-021" (real Postgres, one pristine run per scenario since G1: cost 0.1001 → failed/canary-contract, 0 observations/aspects, event 0.100100; conflict → same, event 0.020000; unknown count → same; conforming answer → completed, 3 observations, attempts 1) | PASS (E1, re-proven G1) |
| CT-SNT-004 | E2: contract carries `classifierInputHash` (`sentimentInputHash`) and `providerPromptSha256` (SHA-256 of `buildSentimentPrompt`), both computed by `inspect` from the candidates the job uses; preflight refuses `contract-input-hash`/`contract-prompt-hash`; the injected classifier boundary recomputes both after the job reloaded roster and mentions — rename, alias, candidate order (canonical hash equal, prompt digest differs) → `input-hash-drift`/`prompt-hash-drift`, 0 provider calls, no usage event, analysis `failed`/`canary-input-drift` | `canary.test.ts` ("E2", 4 tests + preflight digest cases) | PASS (E2) |
| OPS-SNT-002 | E3/E4: `run --contract <file> --contract-sha256 <hex>` — supervisor verifies the raw-byte digest before spawning, the child re-reads and re-verifies before any DB/provider step; mismatch/format/unreadable/not-JSON → exit 3; child mode requires the supervisor's one-time token (secret in env, digest on argv, never logged) — direct `--child`, guessed proof, foreign secret → `refused: child-token` exit 3 with no report, no DB connection, no provider path, no 64-hex in output | `apps/worker/src/__tests__/sentiment-canary-guard.test.ts` (2) + `sentiment-canary-driver.test.ts` (5 process tests spawning the real driver against a dead DATABASE_URL) | PASS (E3, E4) |
| UT-SNT-012 | F1 RED→GREEN: two environments with the same logical mentions but opposite mention-row UUID order give the same candidate order (brand first, competitors by key), the same rendered prompt and digests, byte-identical `inspect` output and canonical contract `entities[]`; detector path = stored-mentions path; `sentimentInputHash` frozen value unchanged; rename/alias still change both digests; a real entity-set change still blocks the call | `packages/lib/src/sentiment/__tests__/candidate-order.test.ts` (9 tests; RED commit e5c28d7c) | PASS (F1) |
| IT-SNT-022 | Two throwaway databases on the disposable server, full migration chain, identical logical data: mention rows with opposite UUID order → committed `inspect` (child process per DATABASE_URL) prints byte-identical contracts and the same raw SHA-256 (RED with the pre-fix scripts: bytes differ); independent mention backfills (random UUIDs) → identical contracts; second apply + dry run leave every digest unchanged; run state `pristine` | `apps/web/src/server/__tests__/sentiment-candidate-order.integration.test.ts` (3 tests, real Postgres) | PASS (F1) |
| CT-SNT-005 | Canary isolation, one authorized attempt per run: preflight refuses `run-not-pristine` for every state except "no analysis row" or `pending/0/0` — pending after a claim, processing, failed (even with zero observations), completed, no_mentions, any observations; refused invocations make 0 attempts, 0 provider calls, no persist, no usage event, no DB change; a second invocation under the same contract after a provider failure never reaches the provider; `inspectSentimentCanaryRunState` shares the predicate; the operator acceptance seed requires `SKIP_RUN_IDS` | `canary-single-attempt.test.ts` (11: state matrix ×9, repeat invocation, safe detail) + `canary.test.ts` + `sentiment-pipeline.integration.test.ts` "IT-SNT-023" (real Postgres: pending/0/0 → one provider error → failed/1/0 → same contract refused `failed/1/0`, second provider untouched, attempts 1, 0 observations/aspects, usage events not duplicated) | PASS (F1, G1) |
| CT-SNT-007 | Read-only pristine preflight vs atomic canary-only pristine claim: (1) preflight `run-not-pristine` is an early informative guard over `loadAnalysisState`; (2) the right to call is `claimAnalysis(..., { pristineOnly: true })` — one UPDATE matching `pending ∧ attempts = 0 ∧ NOT EXISTS observation`; a lost claim → outcome `claimed-elsewhere`, verdict `run-state-drift` with the row's status, 0 provider calls, no persist, no usage event, no write of its own; (3) concurrent race RED→GREEN: A and B both pass preflight (barriers), A claims and fails at the provider, B is refused at the claim — total provider calls 1, attempts 1, one usage event; simultaneous pristine claims → exactly one winner; a pending/0 row with an observation is not claimable in pristine mode; the worker claim still retries a failed row | `canary-atomic-claim.test.ts` (2; RED 1969250c), `canary.test.ts` (lost pristine claim), `sentiment-pipeline.integration.test.ts` "IT-SNT-024" (barrier race on real Postgres) + "IT-SNT-024b" (8 simultaneous claims, observation NOT EXISTS, worker retry unchanged) | PASS (G3) |
| CT-SNT-006 | Contract `entities[]` unique by `entityType:key` at schema level: exact duplicate and reordered duplicate → `invalid-contract` before any store/provider dependency; distinct entities and competitor-only contracts accepted; `inspect` output still parses byte-reproducibly | `canary.test.ts` ("G2: entities[] must be unique…"), IT-SNT-022 | PASS (G2) |
| IT-SNT-018 | Persistence failure after a paid answer: provider called once, the real observation insert fails (FK inside the transaction), exactly one `sentiment_classification` usage event with the charged cost, no `_failed` event, analysis `failed`/`persistence`, zero observation/aspect rows, recoverable on the next attempt; usage-write failure never replaces the persistence error and is attempted once | `packages/lib/src/sentiment/__tests__/job.test.ts` ("C4" ×4) + `sentiment-pipeline.integration.test.ts` "IT-SNT-018" (real Postgres) | PASS (D4) |
| OPS-SNT-001 | Committed driver `apps/worker/scripts/sentiment-canary.ts` (`inspect` read-only contract form without answer text; `run --contract <file> --contract-sha256 <hex> <run-id>` supervised child, exit 0 only on an accepting verdict; frozen run id only); production contract, run logs and refusal proofs kept in operator evidence | `pnpm -C apps/worker canary:sentiment …`; evidence `~/.elmo-task-evidence/sent-01/canary-safety/` (`r3/`) | PASS (D5, re-proven E3/E4) |
| ST-SNT-001…003 | Storybook default/edge/evidence fixtures | `apps/web/src/stories/sentiment.stories.tsx` (11 stories incl. `PriceAspect`; offset-based highlight fixture); Storybook project 172/172 | PASS |
| E2E-SNT-001…006 | Route/sidebar/filter parity, URL state + stale `q`/`model`, expansion + lazy request + 10/10 + deep link, 375/768/1280/1400 + dark + focus + tooltip containment, regressions, SQL oracle | `e2e/tests/local/sentiment.spec.ts` (10 tests) | PASS |
