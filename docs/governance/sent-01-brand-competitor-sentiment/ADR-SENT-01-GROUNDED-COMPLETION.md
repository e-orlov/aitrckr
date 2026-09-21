# ADR-SENT-01-GROUNDED-COMPLETION — completing a sentiment analysis on its grounded claims

- Status: **ACCEPTED**
- Date: 2026-09-17
- Applies to: `sent-classifier-v5` and every later classifier version unless superseded by a new ADR
- Supersedes: the all-or-nothing aspect semantics of `sent-classifier-v4`

## Context

The classifier judges each contract entity overall and, optionally, on the aspects of the taxonomy (`price`, `coverage`, `service`, `other`). Under v4 every validation defect — including a defect of one optional aspect claim, such as a price aspect resting on a generic checklist bullet — made the whole analysis terminal: nothing was persisted, the paid call was attributed as failed, and the run stayed failed for that exact input. Production run `2da20f88` lost a valid overall verdict and a valid coverage aspect this way.

## Decisions

1. **The overall verdict is mandatory.** Every entity of the request contract must have exactly one validated overall verdict. Any defect of an overall verdict — missing, unknown or duplicate entity; entity swap; evidence that names only other candidates; evidence attributable to nobody; category/polarity mismatch; Mixed without one positive and one negative citation; an unknown or unresolved validation code; provider, schema, envelope or request-budget failure — is terminal for the whole analysis. Nothing is persisted, the paid call is attributed under the existing failure policy, and the input is not sent again (all-or-nothing, as before).
2. **Aspects are independent optional grounded claims.** Each aspect claim is validated on its own against the same rules. It exists in the result only when the answer supports it with evidence attributable to that entity.
3. **An absent aspect row means "no sufficient entity-specific evidence in this answer".** It is not a Neutral, not an error and not an incomplete analysis. No Neutral / 0 / 50 placeholder is ever created for an absent aspect, and the overall verdict is never adjusted because aspects are absent.
4. **A valid overall with zero aspects is `completed`.** Completeness is defined by decisions 1–3, never by the number of aspect rows.
5. **An allow-listed aspect-local defect drops only that aspect claim.** The closed allow-list is `aspect-ungrounded`, `evidence-entity-unbound`, `polarity-category-mismatch`, `mixed-needs-dual-evidence`, `evidence-anchor-polarity-conflict`, and it applies only when the defect's diagnostic names exactly that entity and that aspect. Any other code, an ambiguous diagnostic, a duplicate or unknown aspect, or a foreign error stays terminal (fail closed). No count of dropped claims turns an analysis terminal; a high drop rate is an operational signal, not a property of one analysis.
6. **An overall defect is terminal even when the same code would be aspect-local.** The code decides nothing on its own; the target does.
7. **No partial states, no synthetic values, no second call.** There is no `Partial`, `completed-with-partial`, `accept-with-warnings` or "aspect excluded" state anywhere — not in the analysis status, the job outcome, the canary verdict or the page. Dropped claims are recorded for the operator in `sentiment_filtered_claims` (analysis identity, entity identity and type, aspect key, allow-listed code, cited anchor ids, classifier version, timestamp — never text). A completed analysis is never re-sent to the provider; a repeat job for the same input makes no call.
8. **The read selector works on whole analyses: v5 → v4 → v3.** For each prompt run exactly one completed analysis of the most preferred readable version is selected, under the current taxonomy.
9. **No mixing of versions inside a selected analysis.** The overall observation and the aspect rows shown for a run come from the selected analysis only; aspects of an older completed analysis are never merged into a selected v5 analysis, not even when the v5 analysis has zero aspects.
10. **A failed or pending v5 analysis hides nothing.** While no completed v5 analysis exists for a run, its completed v4 or v3 analysis stays selected in full.

## Amendment A — approved (2026-09-17)

The audit of dropped claims is stored in its own table `sentiment_filtered_claims` (migration `0022`) rather than in a JSONB column on `sentiment_analyses`. The table carries a cascading foreign key to `sentiment_analyses`, database CHECK constraints on the aspect keys, the entity types and the five allow-listed codes, and a database-enforced maximum of one row per `(analysis, entity, aspect)`. Rows are written in the same transaction as the observations and replaced with them; a failed analysis has none. This amends the physical model only; the product semantics above are unchanged.

## Amendment B — eventual resolution (recorded 2026-09-18; implemented and accepted on the SENT-v5 branch, Slice A through B0.2)

Amendment B replaces the "terminal for the whole analysis … the input is not sent again" disposition of Decision 1, the "no second call" clause of Decision 7 and the first Consequence with a bounded resolution workflow. Decisions 2–6 and 8–10, Amendment A and the closed aspect-local allow-list are unchanged. Names below are the identifiers in `packages/lib/src/sentiment/` (`job.ts`, `resolution.ts`, `classifier.ts`, `store.ts`, `read-selection.ts`, `types.ts`) and `packages/lib/src/providers/registry/openrouter.ts`.

### B1. Product completion

- A provider or validation failure is an intermediate operational state, never a closed product failure. Work that leaves the automatic path is parked as analysis status `pending_resolution` with an open `sentiment_resolution_cases` row; the v5 workflow never writes `failed` for it.
- The only successful outcome is a result the independent verifier (`SENTIMENT_VERIFIER_VERSION = "sent-verifier-v1"`) accepted, persisted in one transaction together with `verifier_version`, `verified_at`, the observations, the aspect rows and the `sentiment_filtered_claims` audit, and the case set to `resolved`.
- A current-version (`sent-classifier-v5`) row is readable only when `status = 'completed'`, `taxonomy_version = SENTIMENT_TAXONOMY_VERSION` **and** `verified_at IS NOT NULL` (`readableCompletedWhere`). A v5 `completed` row without `verified_at` is not current and selects nothing; older readable versions (v4, v3) never carried the marker and are read as before.

### B2. Resolution identity and fencing

- One resolution case per analysis, identified by an immutable `instance_id` bound to the case's `input_hash`. A changed input opens a new instance; a resolved instance is never re-entered.
- Every write to the current case and analysis is fenced by the claimant's `claim_generation` **and** the case `instance_id` (`ResolutionOwner`); a stale or foreign claimant gets `ClaimLostError` and can neither mutate, park nor charge (`updateResolutionCase`, `chargeResolutionCase`, `openProviderAttempt`).
- Attempt rows are immutable evidence owned by the attempt, not by the claim: a paid answer that arrives after the claim was lost still settles its own `sentiment_provider_attempts` row (outcome, generation id, charged cost, candidate) without mutating the winning claimant's case, analysis or projection. An answer of an obsolete instance lands on its own old-instance row only.

### B3. Attempt ledger and billing

- `sentiment_provider_attempts` is the source of truth for paid calls and cost: one row per request, opened as `sending` before the request leaves, settled once to `accepted` / `rejected` (a paid answer, usable or not) or `provider-error` / `aborted` (unpaid or unknown); the generation id is required on every paid row.
- Settling a paid answer (`finishProviderAttempt`) and inserting its usage event happen in one transaction; the settlement is idempotent (`"settled"` writes the event, `"already-settled"` writes nothing, a conflicting replay raises `AttemptSettlementConflictError`). Every paid answer is attributed exactly once. A shaped answer is attributed as `sentiment_classification` even when the deterministic assessment rejects it; only an answer that could not be shaped (`schema`, `invalid-json`, `no-content` envelopes) is attributed as `sentiment_classification_failed`. Both carry the provider's charged cost, never the estimate.
- The case's `automated_provider_calls` and `total_actual_cost_usd` are caches recomputed from the instance's `accepted`/`rejected` attempts inside that same transaction (`chargeResolutionCase`) before any further budget decision (`RESOLUTION_POLICY`: `maxPaidCalls 5`, `maxCostUsd 0.15`, `maxInitialClassifications 1`).
- Known limitation: `usage_events` has no `attempt_id` (columns: organization, brand, prompt, event type, provider, model, web search, units, `estimated_cost_usd`, created at). Per-attempt attribution is therefore proven by the 1:1 write inside the settlement transaction and by ledger/usage reconciliation, not by a stored join key.

### B4. Retry routing

- Exactly two refusals may be repeated automatically (`AUTOMATIC_RETRY_ALLOW_LIST`): HTTP `429` with canonical type `rate_limit_exceeded`, and HTTP `503` with canonical type `provider_overloaded` — only when the response is OpenRouter's structured error envelope carrying no generation id, usage, cost, content or partial output. The retry parks the case as `retry_wait` with `backoffMs` (`backoffBaseMs 60 s`, doubling, `backoffMaxMs 15 min`, or the provider's `Retry-After` capped by the same maximum); an unpaid attempt does not count against the budget.
- The canonical type is read from `error.metadata.error_type` only (`canonicalErrorType` in `openrouter.ts`). The message text, raw body, provider-specific codes, the HTTP status class, a missing generation id or any heuristic never type a refusal.
- Deterministic refusals of the request itself (`REVIEW_STATUSES` 400, 401, 402, 403, 404, 409, 422 — request, authentication, permission, credit, configuration) and local defects with the request demonstrably never sent hand over to `awaiting_review` with `review_reason = 'contract-defect'`.
- Everything whose billing outcome is unknown — timeout, abort, connection loss, status-less errors, HTTP 408, untyped or ambiguous 5xx, unknown types, and any refusal that carried output — hands over to `awaiting_reconciliation` with `review_reason = 'unknown-provider-outcome'`; the attempt row keeps `sending` (or `aborted`) as the reconciliation record. None of these can cause a second provider call.

### B5. Lost-answer settlement and resume

- The normalized candidate of every accepted `classify` or `repair` answer is stored on its attempt row (`candidate`, migration `0023`); verifier answers store no candidate.
- A new claim may resume a case parked as `awaiting_reconciliation` / `unknown-provider-outcome` from the latest same-instance `classify`/`repair` attempt that is `accepted`, schema-valid and carries the case's `input_hash`, while no attempt is still `sending` (`resumableEvidence`). The resumed workflow first recomputes the budget from the ledger, then continues without repeating that paid phase; a stored repair candidate proceeds to verification without another repair.
- A late verifier answer is settled on its own attempt row but is never a reusable verdict: a resumed case is verified again with one new call before it can complete.
- The immediate `enqueueResume` after a lost-claim settlement is an optimization; a refused immediate send (`null`) is not a success. The durable wake-up is `enqueueResumableSentimentRuns` on the worker's maintenance schedule (`*/5 * * * *`), which lists exactly the cases the resume predicate accepts and enqueues through the singleton-keyed send, so a queued successor is never duplicated. No fixed completion time is guaranteed: a case waits at least until its `retry_wait` expires or the next maintenance pass, and up to the automatic budget.

### B6. Validation disposition

- Contract defects (`CONTRACT_DEFECT_CODES` = `schema`, `unknown-entity`, `duplicate-entity`; also a wire-schema or envelope failure of the answer itself) leave the automatic workflow immediately after the one paid answer: `awaiting_review` / `contract-defect`, no repair, no verification. They are not repaired first, and they do not become terminal failures.
- Repair targets (`UnresolvedTarget`, source `deterministic`) are: an entity whose overall verdict fails any `validateOneEntity` rule outside the contract-defect set — the codes raised there are `entity-ungrounded`, `evidence-entity-unbound`, `polarity-category-mismatch`, `mixed-needs-dual-evidence`, `evidence-anchor-polarity-conflict`, `evidence-unknown-anchor`, `score-category`, `duplicate-aspect`; an aspect defect whose diagnostic does not name exactly one entity and one aspect (an ambiguous, unknown or duplicate aspect); and `missing-entity` for a contract entity absent from the answer. Verifier rejections add targets with source `verifier` and reason `verifier:<code>` for `VERIFIER_ISSUE_CODES` (`entity-misattribution`, `polarity-mismatch`, `category-mismatch`, `mixed-semantics`, `aspect-misrouted`, `unsupported-evaluation`). Targets are repaired by one targeted `repair` request per round, merged into the candidate, re-assessed, and verified as a whole.
- Aspect-local defects that name exactly one entity and aspect are still dropped locally under Decision 5 and never trigger a repair.
- Exhausting `maxPaidCalls`, `maxCostUsd` or `maxInitialClassifications` hands over with `review_reason` `call-limit`, `cost-limit` or `initial-classification-limit`. `REVIEW_REASONS` is the closed set `call-limit`, `cost-limit`, `contract-defect`, `unknown-provider-outcome`, `initial-classification-limit`; `RESOLUTION_CASE_STATUSES` is `open`, `repairing`, `verifying`, `retry_wait`, `awaiting_review`, `awaiting_reconciliation`, `resolved`.
- The job outcome `terminal-validation-failure` remains in the `SentimentJobOutcome` type for tooling that reads historical outcomes only; the v5 workflow never emits it.

### B7. Taxonomy identity

- The taxonomy is derived from the classifier version: `SENTIMENT_TAXONOMY_VERSION = SENTIMENT_CLASSIFIER_TAXONOMIES[SENTIMENT_CLASSIFIER_VERSION]` (v3, v4 and v5 all ship `sent-aspects-v1`). There is no way to change the current taxonomy without adding a classifier version.
- A current-version row whose `taxonomy_version` differs from the derived value is configuration drift (`isTaxonomyDrift`): the inventory and the worker both refuse to act on it, log it and return `skipped`; nothing is claimed, called or rewritten.
- A supported taxonomy change ships as a classifier-version bump with its own taxonomy entry: every stored analysis of the old version becomes history (still readable through the version fallback) and the new identity is eligible exactly once.

### B8. Migration and recovery model

- `0022_sentiment_grounded_completion` (journal idx 22, `when` 1789677161892) establishes the grounded resolution state: `sentiment_filtered_claims` (Amendment A), `sentiment_provider_attempts`, `sentiment_resolution_cases`, the `pending_resolution` status and the `verifier_version` / `verified_at` columns on `sentiment_analyses`.
- `0023_sentiment_attempt_candidate` (idx 23, `when` 1789683590461) adds the nullable `sentiment_provider_attempts.candidate jsonb` with a CHECK that admits `NULL` or a JSON object only; legacy attempt rows keep `NULL`.
- The earlier PR-lineage file `0022_sentiment_filtered_claims` (`when` 1789667218345) and the interim `0022_sentiment_grounded_completion` at `when` 1789670309106 are not compatible predecessors of this chain: the Drizzle migrator applies every journal entry newer than the database's last `created_at` and compares no hash, so a database that applied either of them would attempt the final 0022 again and fail on the existing table. Only the final local 0022 → 0023 lineage is intended for integration; a database migrated through `main` (0021) or through this lineage upgrades cleanly.

### B9. Traceability

| Decision | Automated evidence (smallest relevant files) |
|---|---|
| B1 completion, `pending_resolution`, verified-only current rows | `apps/web/src/server/__tests__/sentiment-v5-corrective-a.integration.test.ts` (C, D, H), `sentiment-v5-resolution.integration.test.ts` (S1, S16/S17), `sentiment-pipeline.integration.test.ts` |
| B2 immutable instance, claim + instance fencing, attempt-owned late evidence | `sentiment-v5-corrective-a.integration.test.ts` (A, B, I), `sentiment-v5-late-settlement.integration.test.ts` (A2A-1 … A2A-5), `sentiment-v5-resolution.integration.test.ts` (S12–S14) |
| B3 ledger truth, atomic idempotent settlement, ledger→case reconciliation, attribution | `sentiment-v5-corrective-a.integration.test.ts` (G), `sentiment-v5-resolution.integration.test.ts` (S18), `sentiment-v5-late-settlement.integration.test.ts` (A2A-2, A2A-3), `sentiment-v5-adr.integration.test.ts` (IT-V5-ADR-001/003), `packages/lib/src/sentiment/__tests__/job.test.ts` |
| B4 closed retry allow-list, canonical `error_type`, review vs reconciliation | `packages/lib/src/sentiment/__tests__/v5-provider-routing.test.ts`, `packages/lib/src/providers/registry/openrouter.test.ts`, `sentiment-v5-corrective-a.integration.test.ts` (E, F), `sentiment-v5-resolution.integration.test.ts` (S8) |
| B5 stored candidate, resume without repeating a paid phase, late verdict not reused, durable wake-up | `sentiment-v5-resume.integration.test.ts` (A2B-1 … A2B-7), `sentiment-v5-resume-wakeup.integration.test.ts` (A2B1-1 … A2B1-6, exercising `enqueueResumableSentimentRuns` as `apps/worker/src/jobs/schedule-maintenance.ts` calls it) |
| B6 contract defects hand over; repair-target set; aspect-local drop; budget hand-over | `sentiment-citation-exclusion.integration.test.ts` (IT-SNT-CIT-001 failure shapes), `sentiment-v5-adr.integration.test.ts` (IT-V5-ADR-001 … 005), `sentiment-v5-resolution.integration.test.ts` (S2–S7, S9), `packages/lib/src/sentiment/__tests__/v5-resolution.test.ts`, `v5-grounded-claim-completion.test.ts` |
| B7 taxonomy derived from version, drift non-actionable, bump creates identity | `sentiment-v5-taxonomy-identity.integration.test.ts` (A3-0 … A3-5), `sentiment-pipeline.integration.test.ts` (IT-SNT-011, IT-SNT-016) |
| B8 0022/0023 lineage and upgrade | `sentiment-candidate-order.integration.test.ts` (journal-derived migration count), B0 disposable fresh and 0022→0023 upgrade evidence (`~/.elmo-task-evidence/sent-01/classifier-v5/b0-20260918/`) |
| B1–B6 read selection unchanged (v5 → v4 → v3, no version mixing) | `sentiment-v5-completion.integration.test.ts` (V5-RED-014/015), `sentiment-v5-adr.integration.test.ts` (no version mixing), `sentiment-version-fallback.integration.test.ts` |

Automated guarantees end at the provider double: the suites prove the workflow's routing, fencing, ledger, resume and read-path behavior on real Postgres with scripted answers. Still requiring production real-life acceptance under a later gate: the live OpenRouter refusal envelopes actually carrying `error.metadata.error_type` as assumed, the verifier's real accept/reject rate and its effect on paid-call volume, the operator review load of `awaiting_review` / `awaiting_reconciliation` cases, and the upgrade of the production database from its `main` journal state.

## Amendment C — dispatch safety controls (recorded 2026-09-21; implemented in F2-PR-1)

Amendment C adds the controls required before the corrected v5 runtime may run against the provider again: a durable dispatch hold, permits as its only bypass, a per-request-profile circuit breaker, and a retry path that never depends on the queue's retry loop or on a worker clock. It changes no product semantics of Amendments A and B: verified-only completion, instance fencing, the attempt ledger as billing truth and the review/reconciliation dispositions all stand.

### C1. Dispatch hold

- One control row (`sentiment_controls`, key `dispatch`) with state `held` or `open`, an epoch, and the actor, reason and correlation of its last transition. Migration `0024_sentiment_dispatch_controls` seeds it `held`; a fresh or upgraded database therefore dispatches nothing until an operator opens it.
- Readers fail closed: an absent row, an unknown state or any read error is `held`.
- Transitions are compare-and-swap on the current state (`transitionDispatch`), bump the epoch and append one `sentiment_control_events` row in the same transaction. Repeating a command finds the row already moved and is refused without writing.
- Gates: the natural producer (`enqueueSentimentBestEffort`) reads the hold **after** `ensureAnalysis`, so the pending analysis row is the durable record of held work; maintenance rediscovery (`enqueueResumableSentimentRuns`) and historical backfill (`runSentimentEnqueue --enqueue`) are skipped or refused while held; the job core reads the hold after `ensureAnalysis` and before `claimAnalysis` and completes as `held` without claiming; every request passes the dispatch transaction (C3) and the guarded provider (C4).
- `open` changes gating only. Held work is released by the explicit, bounded, audited `release-held` command from the rows the gates left behind: (A) a current-version analysis `pending` with zero attempts, (B) a current-detector mentions receipt for a run with no analysis row of any version. Historical runs are never selected — every mention-bearing historical run already carries an analysis row — and `backfill:sentiment --enqueue` remains the only historical path.

### C2. Permits

- `sentiment_dispatch_permits`: one live permit per `(analysis_id, instance_id)` (partial unique index), bound to the exact `input_hash`, with purpose `canary` or `resume-verify`, a per-phase budget in `{0,1}` for classify, repair and verify, a database-clock expiry, and an `estimated_cost_budget_usd` (≤ 0.10) against which planning reservations are tracked.
- A permit is consumed per phase inside the dispatch transaction, before the `sending` attempt row exists. A consumed phase is never returned automatically; a permit with a dangling `sending` attempt cannot buy another call — recovery is the evidence-based reconciliation of that attempt, never a refund by the job.
- Under `open` dispatch permits are not consulted; under `held` no request is possible without a matching valid permit.

### C3. Dispatch transaction T1

Order before every provider request: (1) the local strict-schema guard — a refusal opens the breaker and writes no attempt; (2) read the hold; (3) compute the `rp1:` request-profile scope and read its breaker; (4) in one transaction: acquire the half-open probe lease when the scope is probing, consume the permitted phase when held (enforcing the phase budget, expiry, instance/input binding and `settled + reserved + R_next ≤ estimated_cost_budget_usd`), and create the `sending` attempt carrying `permit_id`, `scope_key`, `schema_fp` and `reserved_estimate_usd`. Anything refused rolls the transaction back, leaves no row, and parks the case (`retry_wait`, no due time or the breaker's `open_until`) without a request.

### C4. Guarded provider and fingerprints

- The workflow wraps whatever resolved the provider (production lock, canary wrapper, test double) once per lifecycle. Immediately before the adapter's network call the wrapper requires the explicit dispatch context set by T1, recomputes `sfp1:` and `rp1:` from the document and options it is about to send and requires equality, requires the attempt to be `sending` with the same permit, and requires a permit under a held dispatch. Any mismatch closes the attempt as `aborted`, parks the case and logs `gate-breach`; nothing is sent.
- `sfp1:` normalizes only the two run-specific `$defs` (`anchorId`, `entityKey`) to a template marker; verdicts, issue codes, aspect enums, constraints, closure, references and nesting remain part of the shape; keys and `required`/`enum` order are canonicalized. `rp1:` hashes adapter, endpoint, model, tool mode, strict-output mode and the `sfp1:` shape. Failure class and phase are evidence, not key components.

### C5. Breaker

- One row per `rp1:` scope (`sentiment_provider_breakers`); an absent row is `closed`. Opens on one strike for a local `StructuredOutputSchemaError` (no request, no attempt row; sibling scopes sharing the schema shape are opened too) and for a structured, output-less HTTP 400. Never opens on 429, 5xx, timeouts or transport ambiguity, paid answers the contract could not shape, or refusals that carry output.
- Backoff 15 min × 2ⁿ⁻¹ capped at 6 h. One conditional `UPDATE` grants the single half-open probe to one attempt with a 900 s lease and a bumped generation; Read Committed re-evaluation keeps concurrent workers out. An accepted probe closes the scope; a deterministic refusal re-opens it with a longer backoff; an expired lease may be taken over. Operators may reset an open scope to `half_open` only and may open a scope for containment; there is no force-close.

### C6. Retry-wait

- An allow-listed transient refusal parks the case (`retry_wait`, due time from the database clock) and the job completes with `retry-wait`; the queue does not retry it. A case not due within the inline wait completes as `deferred`, never called early. The maintenance inventory rediscovers due `retry_wait` cases (including cases parked by the hold or the breaker) through the `(status, next_attempt_at)` index, at most 25 per tick, through the singleton-keyed send. Five consecutive transient refusals hand the case to review as `retry-exhausted`.
- A paid answer without a generation id settles as a paid, rejected attempt (never as unsent) and hands the case over.

### C7. Verifier-only resume

- Cases parked for review resume only under a `resume-verify` permit with a `{verify: 1}` budget, a two-hour TTL and a 0.02 estimated budget, issued from a manifest produced by a read-only selector: current instance, recomputed matching input hash, latest accepted classify-or-repair candidate of that instance, zero unresolved assessment, every prior verify attempt unpaid, no verifier version or adjudication, the verifier document accepted by the guard and its scope not blocked. Apply recomputes the selection and refuses on any drift (count, ordered ids, candidate attempt ids); the default batch is 10.

### C8. Terminology for money

`estimated_cost_budget_usd`, `reserved_estimate_usd`, `settled_cost_usd` and the reservation constants (classify 0.05, repair 0.02, verify 0.02; resume 0.02 per case) are planning estimates — never hard dollar ceilings. The enforceable pre-dispatch limits are the permitted phases, the call count, the request token and tool limits, the expiry, the fencing and the single-worker concurrency; actual provider cost is known only after settlement. `52 × 0.02 = 1.04` is an aggregate planning estimate.

### C9. Owner decisions (approved 2026-09-21)

D3 automatic hold on breaker storms disabled in the first release · D4 output-less structured HTTP 400 is a one-strike breaker event · D5 no force-close · D6 breaker backoff 15 min × 2ⁿ capped at 6 h · D7 rediscovery maximum 25 per tick · D12 resume verification reservation 0.02 per case · D16 no deliberately invalid provider request · D17 old/new worker overlap is the later hard deploy gate `G-OVERLAP` · D18 `retry_wait` recovery is required before natural OPEN · D19 reservation estimates classify 0.05 / repair 0.02 / verify 0.02, re-derived after the first 20 verified lifecycles · D20 five consecutive transient failures before `retry-exhausted` · resume TTL two hours, default batch 10 · breaker reset only to `half_open`. Alert policy approved for PR-2 (not implemented here): D8 urgent `refusals-across-shapes` at two or more distinct request-profile scopes with class-2 refusals in 24 h, six-hour cooldown; D9 informational `awaiting-review-growth` when new unacknowledged ids ≥ 5, or — only when the baseline is greater than zero — ≥ `ceil(0.25 × baseline_count)` within 24 h, 24-hour cooldown (with a zero baseline only the absolute threshold applies); D10 informational `held-backlog-growth` at 20 held items or oldest age 48 h, 24-hour cooldown; D11 breaker/probe cooldown one hour per scope, first-contract-defect and cross-shape refusals six hours, growth signals 24 hours.

### C10. `G-OVERLAP` and the watchdog limitation

- The corrected runtime and `g51663818` must never process the shared `classify-sentiment` queue at the same time: each skips the other's payload version and completes the job, so a permit-authorized job fetched by an old worker would be consumed without work. Before the new worker starts: the watchdog scheduled task is disabled, zero old worker containers exist and the queue has no `active` sentiment job; before any permit or release: exactly one worker of the new image; on rollback the new worker is stopped fully before the old one starts. This is a hard deployment gate, not code.
- A watchdog running on the same VM cannot independently report its own death; Task Scheduler state and heartbeat-file inspection are operator evidence, not independent notification. A second observer outside the failure domain is not part of this local-only design unless separately authorized.

### C11. Boundaries

PR-2 owns alert evaluation, baselines and the maintenance heartbeat (the `sentiment_alert_state` table is created here, empty). PR-3 owns the Windows watchdog and status integration. The fixed-300-ms wait in `sentiment-v5-late-settlement.integration.test.ts` is corrected in a separate test-harness PR. This amendment and its PR are not deploy authorization: release build, rehearsal, canary, resume of parked production cases, natural OPEN and historical backfill each require their own GO.

### C12. Traceability

| Decision | Automated evidence |
|---|---|
| C1 fail-closed read, CAS, audit, gate order | `packages/lib/src/sentiment/__tests__/dispatch-controls.test.ts`, `dispatch-job.test.ts`, `dispatch-bypass-registry.test.ts`, `apps/web/src/server/__tests__/sentiment-dispatch-controls.integration.test.ts` (IT-SNT-C-001…003), `apps/worker/scripts/verify-sentiment-db.ts` |
| C1 held-work selection and release | `sentiment-resume-verify.integration.test.ts` (IT-SNT-C-006) |
| C2/C3 permits, T1, reservations, single consumer | `dispatch-job.test.ts`, `sentiment-dispatch-controls.integration.test.ts` (IT-SNT-C-003) |
| C4 fingerprints and guard | `dispatch-fingerprint.test.ts`, `dispatch-job.test.ts` (guarded provider) |
| C5 breaker classes, open, single probe, reset | `dispatch-controls.test.ts`, `dispatch-job.test.ts`, `sentiment-dispatch-controls.integration.test.ts` (IT-SNT-C-004) |
| C6 retry-wait, due gate, rediscovery, exhaustion, paid-without-generation | `dispatch-job.test.ts`, `v5-provider-routing.test.ts`, `job.test.ts`, `sentiment-dispatch-controls.integration.test.ts` (IT-SNT-C-005) |
| C7 resume selector, manifest, apply, verify-only | `resume-selector.test.ts`, `sentiment-resume-verify.integration.test.ts` (IT-SNT-C-007) |

## Consequences

- Runs that v4 rejected for an aspect-only defect complete under v5 with the aspect dropped; runs with an overall defect remain terminal.
- The Sentiment page needs no change: aspect metrics use persisted aspect rows only, an absent aspect is simply absent, and the existing coverage cue (`classified < mentions`) keeps its meaning.
- The prompt states that aspects are optional findings, not a checklist, and that an omitted aspect is the correct answer when the text does not evaluate it for the entity.
