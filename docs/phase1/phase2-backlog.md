# Phase 2 backlog handoff (agreed scope — NOT implemented in Phase 1)

Per master prompt §3.4. Current behavior of all three areas is tested and documented in Phase 1 (feature-test matrix, resilience report J10); no implementation exists in this branch.

1. **Bulk Prompt Import with Tags** — reuse existing `insertPrompts()`; public bulk endpoint for an existing brand; UI flow `CSV upload → parse → preview → validate → existing insertion logic`. Phase 1 note: the prompts editor already supports bulk paste (one per line) capped by `MAX_PROMPTS = 100` (`packages/lib/src/constants.ts`); the user asked whether the cap can be raised — a candidate one-constant change to bundle with this item.
2. **Sentiment changes** — separate PR with tests for positive/negative/neutral classification, mixed sentiment, negation handling, plus regression coverage of existing sentiment behavior (baseline captured at GATE-R3).
3. **HTTP 429 Too Many Requests protection** — rate limiting / retry with backoff. Phase 1 finding (resilience J10): `process-prompt` queue retries at queue level (retryLimit 3, backoff); worker self-re-enqueue uses run-policy `failureBackoffHours` (0.25h observed on DEF-003); no provider-level 429 handling exists.
