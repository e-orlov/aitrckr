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

## Traceability — SENT-R1/R2 (frozen, implemented in the second PR)

| Test ID | Required proof |
|---|---|
| UT-SNT-001 | Score/category boundaries, Mixed vs Neutral, null behaviour, round-once |
| UT-SNT-002 | Canonical T/M/C/P/U/X/N formulas using the mandated fixture |
| UT-SNT-003 | Entity detection with aliases, domains, Unicode boundaries, repetition, citation-only exclusion |
| UT-SNT-004 | Entity-targeted comparisons, negations and multi-entity attribution |
| UT-SNT-005 | Versioned aspect normalization and overall/aspect divergence |
| UT-SNT-006 | Evidence matching/offset validation and Mixed dual evidence |
| UT-SNT-007 | Deterministic top/bottom non-overlap and tie-breaks |
| UT-SNT-008 | Adaptive buckets, null gaps, Top-6 roster and stable sorting |
| GOLD-SNT-001 | ≥40 synthetic labelled DE/EN cases; 100 % schema/identity/consistency, ≥90 % category, ≥85 % aspect agreement |
| CT-SNT-001 | Tables, checks, unique constraints, RLS and indexes |
| CT-SNT-002 | Structured research uses `openai/gpt-5-mini`, strict schema and web search; no Luna override |
| IT-SNT-001…009 | Job lifecycle, queue dedupe, enqueue-failure isolation, backfill dry run/cursor, paid enqueue limit, overview/evidence auth + read-only, run deep link, migrations on empty and populated databases |
| ST-SNT-001…003 | Storybook default/edge/evidence fixtures |
| E2E-SNT-001…006 | Route/sidebar/filter parity, URL state, expansion + deep link, responsive/dark/a11y, regressions, SQL oracle |
