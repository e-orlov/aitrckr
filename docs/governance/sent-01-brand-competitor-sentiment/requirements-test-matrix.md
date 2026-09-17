# SENT-01 Brand & Competitor Sentiment — requirements and test traceability

Executable contract frozen at CP1 (2026-09-11) before implementation. Two deliverables ship
in order: **SENT-R0** (competitor identity preservation — **CLOSED 2026-09-12**, see
`docs/governance/sent-r0-competitor-identity-closeout.md`) and **SENT-R1/R2** (sentiment truth
foundation + analytics page). Status is updated as each PR lands.

## Frozen versions and constants

| Item | Value |
|---|---|
| Competitor lifecycle | `competitors.active boolean not null default true`, `competitors.removed_at timestamptz null`, `competitors.previous_names text[] not null default '{}'`, index `competitors_brand_id_active_idx (brand_id, active)` |
| Mention detector version | `sent-detector-v2` (v1 retired by round 7: it scanned URLs, link destinations and source lines; v2 scans natural-language ranges only and never matches a domain) |
| Sentiment classifier version | `sent-classifier-v4` (v1 retired by the grounded-evidence corrective: the provider cited free-text quotes; v2 cited anchors but typed the entity key as any string and read citation fragments; v3 bound the key to a per-request enum, read natural-language segments only and hashed the analyzable text but accepted structurally valid evidence attributed to the wrong entity, generic entity-less anchors, descriptive statistics as praise and category/evidence polarity mismatches; v4 is a category-discriminated wire contract — Positive/Negative/Neutral cite only their own polarity, Mixed carries `positiveEvidence` + `negativeEvidence` — with a deterministic entity–anchor grounding guard, polarity-first prompting, canonical aspect routing and statistics-neutral rules) |
| Readable classifier versions (transitional read policy) | `SENTIMENT_READABLE_CLASSIFIER_VERSIONS = [sent-classifier-v4, sent-classifier-v3]` — every Sentiment read selects one analysis per run (`selectedSentimentAnalysisIds`): the completed v4 analysis, else the completed v3 analysis; a failed/pending v4 never hides v3; v2 and older are never read; both versions are never counted for one run; no version label in the UI. Intentional compatibility policy so the 73 production v3 analyses stay visible until reclassified; removing the fallback is a later explicit decision |
| Evidence contract version | `sent-evidence-v2` — the answer is sent as numbered natural-language segments `[s0001]…` (citation ranges are never segments; a citation inside a sentence stays in the raw slice but is elided from what the provider reads); evidence is `{ anchorId, polarity }` against a per-request enum of this answer's ids; the code resolves each anchor to the exact raw `{ quote, start, end }`; frozen in the canary contract (`evidenceVersion`, with `detectorVersion` beside it) |
| Aspect taxonomy version | `sent-aspects-v1` — canonical keys `price`, `coverage`, `service`, `other` |
| Classifier model/path | existing `Provider.runStructuredResearch({ webSearch: true })` → OpenRouter `DEFAULT_RESEARCH_MODEL = openai/gpt-5-mini`, strict JSON schema with the entity-key enum, `provider.require_parameters`; web search through whatever the shared OpenRouter path sends on `main` (since LOC-01 #36: `openrouter:web_search` server tool, `engine: native`, German `user_location`, one mandatory search); no override, no Luna; validated by one bounded canary at CP6 |
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

Corrective round 5 (task SENT-GROUNDED-EVIDENCE, after the first paid canary was CONSUMED-FAIL on 2026-09-13 with
`evidence-not-in-answer`, providerCalls 1, charged $0.020047, 0 observations): the provider typed its evidence as free
text and the classifier searched for it in the answer, so a paraphrase passed the strict schema, failed locally, was
recorded as a `sentiment_classification_failed` event with the tunable estimate instead of the charged cost, and would
have been retried by the queue for the same input (RED: `grounded-evidence.test.ts`, commit df44dee5). Now the answer
is segmented deterministically into anchors (H1), the provider cites anchor ids from a per-request enum and the code
resolves them to the stored `{ quote, start, end, polarity }` form (H2, classifier `sent-classifier-v2`, evidence
contract `sent-evidence-v1` frozen in the canary contract); OpenRouter reads the generation id, request summary and
numeric usage before it looks at the content and reports content defects as a typed error carrying that envelope (H3);
a locally rejected paid answer is attributed with the charged cost and completes the job as a
`terminal-validation-failure` — failed row with the exact input hash and a validation code, never retried for the same
input under the same versions, transient provider/network/persistence failures still throw for the queue (H4); the
only detail that leaves a rejected answer is a ≤512-byte allowlisted diagnostic (H5). No detector, taxonomy or schema
migration change. Round 5b (same PR, MERGE GO withheld): the successful path lost the generation id after the
classifier and a canary could accept an answer it cannot reconcile against the provider's ledger (H1 → reject code
`generation-id-missing`); the sanitized envelope copied `request.model` as a 128-character slice and normalized counters
loosely (H2 → field-by-field allowlist: locked model or no request summary at all, safe integers, finite cost,
booleans).

Corrective round 6 (task SENT-EVIDENCE-EXCERPTS-01, after production acceptance of g486e8e2c found the deviation): the
evidence card showed one ±160-character window around the *first* cited span, so with anchored evidence (up to three
sentence-length anchors spread over the answer) 27 of the first 75 live spans were truncated in the `<mark>` (data exact,
presentation wrong). **Evidence rendering contract:** every stored span is rendered in full —
`rendered highlighted text === answerBody.slice(start, end)` — never truncated, dropped, paraphrased, merged into another
span or re-derived from normalized text. A pure, deterministic planner (`apps/web/src/lib/sentiment-excerpts.ts`) builds
one raw-offset window per span (`EXCERPT_RADIUS` 160 each side, grown outward only to a word/sentence boundary within
`EXCERPT_BOUNDARY_REACH` 40, clamped to the answer, never cutting a span or a surrogate pair), merges overlapping or
touching windows, keeps distant ones apart (one span → one excerpt, three distant anchors → three excerpts, never one
range from first to last), shows an ellipsis only where stored text is skipped, and is independent of input order;
malformed or out-of-range spans are refused (loader leaves them unhighlighted and logs the observation id only). The card
renders every group at once with `<mark>` per highlight (`data-polarity`), "Evidence n of N" and a visible gap when there
are several, one deep link per answer; no tooltip/carousel/horizontal scroll; no classifier, prompt, version, schema,
scoring, queue or data change. Separate semantic finding recorded (CP1): one live aspect was inferred from a citation
URL only — `SENT-CITATION-EXCLUSION DECISION REQUIRED`, out of this PR's scope.

Corrective round 7 (task SENT-CITATION-EXCLUSION-01, after the first live day on g486e8e2c): the read-only forensic
of three terminal failures and the CP1 citation finding established three distinct structural causes. (1) **Citation-only
occurrences**: the detector scanned the whole normalized body including URL tokens and Markdown link destinations and the
segmenter had no notion of citation ranges, so an entity present only as a citation domain (`([adac.de](https://…))`,
isolated as its own anchor because it follows sentence-final punctuation) became a mention, a forced candidate and the
only citable anchor for a coverage aspect. (2) **`unknown-entity` ×2**: the request JSON Schema typed the entity `key` as an
unconstrained string, so strict structured output legally returned the display name `ARAG` for the candidate whose opaque
key is `brand`; the local allowlist rejected it (correctly, fail-closed). Citation exclusion does not touch this failure.
(3) **`evidence-anchor-polarity-conflict`**: the diagnostic (`aspectKey = null`, `evidenceIndex = 1`, anchor `s0004`, a
natural-language segment) proves the provider cited one segment twice with two polarity labels inside one entity's
*overall* evidence list under a non-Mixed verdict; the validator was already target-scoped (a segment carrying different
polarities for different aspects is accepted), so the rejection was correct and no product-semantics change is needed.

**Frozen semantics (round 7).** *Mentions*: an entity is mentioned only when its name or an allowed alias occurs in the
natural-language text of the answer. Not mentions: bare URLs and domains, Markdown link destinations, standalone Markdown
links and source-list entries, reference/footnote markers and link definitions, source lines, a name or alias that occurs
only inside a hostname, path, query or citation label, any other technical representation of a source. A prose mention
beside an inline citation is kept; an entity present in prose and in citation metadata counts once, from the prose;
citations stay a separate analytical layer and never weigh on sentiment. *Evidence*: anchors are natural-language ranges
only; a citation fragment is never an anchor, never an anchor edge and never renders to the provider; a citation inside a
sentence stays inside the anchor's raw slice (`quote === answerBody.slice(start, end)` is preserved; offsets are never
taken from a normalized copy) but is elided from the text the provider reads. *Entity keys*: the request schema carries a
per-request `enum` of the exact opaque candidate keys (strict), the prompt states that keys are echoed verbatim, the request
sets `provider.require_parameters`, and the local allowlist remains the second boundary; no alias-to-key repair, no fuzzy
matching. *Evidence polarity*: a claim is identified by `{ entity, target (overall | aspect), anchor, polarity }`; identical
claims within one target are de-duplicated deterministically; one anchor may carry different polarities for different
targets; positive and negative on one anchor within one target are admissible only under Mixed for that exact target;
any other differing pair on one anchor within one target stays a terminal validation failure; evidence is never dropped,
rewritten or re-labelled. One shared deterministic range analysis (`ranges.ts`) feeds the detector, candidate
construction, the segmenter, the input hash, the prompt, the canary inspect/preflight/boundary and the backfill.

**Version impact (round 7).** Detector `sent-detector-v1 → v2` (citation ranges excluded; domains are not mention terms),
evidence contract `sent-evidence-v1 → v2` (natural-language anchors, elided rendering), classifier
`sent-classifier-v2 → v3` (entity-key enum, prompt rules, rendering, input hash over analyzable text); aspect taxonomy
`sent-aspects-v1` unchanged; the canary contract gains `detectorVersion` and an old contract is refused at parse time. No
schema migration: versions are text columns; old rows stay for audit and are invisible to the current projection.

| Test ID | Required proof | Where | Status |
|---|---|---|---|
| UT-SNT-CIT-001 | RED→GREEN detector: bare domain/URL, Markdown source line, URL path/query carrying an alias, standalone linked brand in a source list → no mention; natural sentence → mention; prose beside an inline URL kept; prose + citation duplicate → one entity; Unicode/CRLF/punctuation/Markdown keep raw offsets; reversed/shuffled roster → byte-identical result; the range module itself: URL/e-mail/bare-domain/link/marker/definition/source-line kinds, natural link labels kept with their destination dropped, abbreviations and dotted names never domains, ordered/non-overlapping/idempotent, elided rendering | `packages/lib/src/sentiment/__tests__/citation-ranges.test.ts` (18; RED commit e339a48c: 11 failures), `detector.test.ts` | PASS |
| UT-SNT-CIT-002 | RED→GREEN anchors: citation-only fragments are not anchors and not anchor edges; natural anchors stay exact raw slices; an excluded fragment cannot be cited as evidence; changing a citation URL leaves input hash and prompt digest unchanged; rendered anchor text carries no URL; UI excerpt planner still shows every admissible span (unchanged, 8 tests) | `__tests__/citation-ranges.test.ts` (RED e339a48c), `anchors.test.ts` (11), `classifier.test.ts`, `prompt-snapshot.test.ts` (prompt/schema snapshots re-pinned), `apps/web/src/lib/__tests__/sentiment-excerpts.test.ts` | PASS |
| UT-SNT-CIT-003 | RED→GREEN live reproducers (sanitized, synthetic): display name `ARAG` for key `brand` → `unknown-entity`; the serialized request JSON Schema had no exact-key enum (RED) and carries `enum: [candidate keys]`, `strict: true`, `provider.require_parameters: true` after; same anchor with different polarities for different aspects passes (regression); same target/non-Mixed differing pair still rejected with the live diagnostic shape (`aspectKey null`, `evidenceIndex 1`); Mixed with dual evidence passes; identical claims de-duplicated (RED); no silent repair | `__tests__/live-reproducers.test.ts` (10; RED commit c93c2bbd: 3 failures), `provider.test.ts`, `prompt-snapshot.test.ts`, `diagnostics.test.ts`/`classifier.test.ts` (poison switched from the now-collapsed duplicate to a polarity conflict) | PASS |
| CT-SNT-CIT-001 | Canary contract carries `detectorVersion`; a contract without it is `invalid-contract` at parse time, one naming `sent-detector-v1` is refused `contract-detector-version` before any store/provider dependency; `inspect` emits it; the post-call contract rejects a request without strict `json_schema` (`request-structured-output`) or without `require_parameters` (`request-require-parameters`); the envelope allowlist keeps both flags as booleans only | `canary.test.ts` (62), `envelope-allowlist.test.ts`, `sentiment-canary-driver.test.ts`, `candidate-order.test.ts` | PASS |
| IT-SNT-CIT-001 | Real Postgres: URL-only competitor mention rows under detector v1 → the reprojection deletes the unreferenced one and supersedes the referenced one (kept, invisible), prose entity keeps its row id under v2, receipts per version, inventories name `staleDetectorVersion`/`staleDetector`, second apply = 0 writes, interrupted batch (`pageSize 2`, `maxPages 2`) resumes from its cursor without re-reading a run (RED: the cursor rounded `created_at` to milliseconds and re-scanned the boundary run — 11 scanned for 9 runs; the cursor now carries the Postgres text timestamp), input hash/prompt digest reproducible via `inspect` and independent of the citation URL, stale v2 analysis physically kept and never counted (page: 9 mentions, 0 classified), no job enqueued by the reprojection or the dry inventory, request schema through the job core binds `["brand", …ids]`, display name → `schema` (paid, terminal, `0.016477` attributed, second job skipped), schema-bypassing display name → `unknown-entity`, same-target polarity pair → `evidence-anchor-polarity-conflict`, canary preflight with the old detector → refused, 0 calls, 0 usage events | `apps/web/src/server/__tests__/sentiment-citation-exclusion.integration.test.ts` (11) | PASS |
| GOLD-SNT-CIT-001 | Golden corpus g43–g49 (bare URLs, linked names inside prose, source list, inline citations after sentences, one sentence with opposite aspect polarities, Mixed aspect on one anchor, UUID-shaped competitor key) and g35 re-labelled as a prose mention beside a domain; against the whole roster the detector finds exactly the candidates; every case's request schema accepts the reference and rejects display-name keys; reference labels validate 100 % | `golden/corpus.ts` (49 cases), `__tests__/golden.test.ts` (8) | PASS |
| UT-SNT-EXC-001 | RED→GREEN: three distant anchors of one answer are each highlighted exactly once as the raw slice; the rendered text of every group equals the raw slice (marks stripped) | `apps/web/src/components/sentiment/__tests__/evidence-visibility.test.tsx` (RED commit abcab90b against the old single window) | PASS |
| UT-SNT-EXC-002 | Planner matrix: one span (window bounds, word boundaries, ellipses); overlapping and touching windows merge, distant stay apart; three distant spans → three groups ≪ whole answer; shuffled/reversed input → byte-identical result; spans at answer start/end; Unicode/surrogates/CRLF with no split pair; identical boundaries with two polarities → one highlight carrying both; malformed/out-of-range spans throw `RangeError` (`isExactEvidenceSpan` false) | `apps/web/src/lib/__tests__/sentiment-excerpts.test.ts` (8) | PASS |
| IT-SNT-EXC-001 | Real Postgres: one observation with three distant anchors → loader returns three excerpt groups, every highlight equals the raw slice, groups are exact slices, total shown < answer; overview loader tests updated to groups; Top/Bottom allocation and ordering unchanged (IT-SNT-007) | `apps/web/src/server/__tests__/sentiment-evidence-excerpts.integration.test.ts` (RED abcab90b), `sentiment-overview.integration.test.ts` | PASS |
| ST-SNT-EXC-001…004 | Storybook: single span (one excerpt, no numbering), adjacent spans (one shared excerpt, two marks in order), three distant spans (three numbered excerpts, negative mark, card shorter than the fictional answer), Mixed on one anchor (one mark with both polarities), DOM order = raw offset order, one deep link per card, no model label; dark; 375 px without horizontal overflow | `apps/web/src/stories/sentiment.stories.tsx` (`EvidenceShapes`, `EvidenceShapesDark`, `EvidenceShapesNarrow`), fixtures via the real planner | PASS |
| E2E-SNT-EXC-001 | Playwright on the seeded stack: Alpha's top answer carries three distant spans → three excerpts, three marks (texts exact, negative polarity attribute), "Evidence 1 of 3" … "3 of 3", offsets ascending, card shorter than the stored answer, single-span items keep one excerpt, one deep link; B7 re-pinned on a single-span item | `e2e/tests/local/sentiment.spec.ts` | PASS |
| OPS-SNT-003 | Production oracle made environment-aware: inactive-competitor and synthetic-exclusion checks derive from the database / an explicit flag and are reported as SKIP (never FAIL) where the fixture is absent; live span counts are dynamic; every span must be rendered as a `<mark>`; excerpt groups must be exact raw slices containing their highlights and never the whole answer | operator driver `~/.elmo-task-evidence/sent-01/evidence-excerpts-01/scripts/sent01-evidence-verify.local.mts` | PASS (rehearsal + production read-only) |
| UT-SNT-001 | Score/category boundaries, Mixed vs Neutral, null behaviour, round-once | `packages/lib/src/sentiment/__tests__/metrics.test.ts` | PASS |
| UT-SNT-002 | Canonical T/M/C/P/U/X/N formulas using the mandated fixture | same (`UT-SNT-002 canonical fixture`) + Storybook `Default` + integration `IT-SNT-006` | PASS |
| UT-SNT-003 | Entity detection with aliases, domains, Unicode boundaries, repetition, citation-only exclusion | `__tests__/detector.test.ts` | PASS |
| UT-SNT-004 | Entity-targeted comparisons, negations and multi-entity attribution | golden corpus critical cases validated through `classifySentiment` | PASS (reference labels); live agreement gated at CP6 |
| UT-SNT-005 | Versioned aspect normalization and overall/aspect divergence | `types.ts` taxonomy `sent-aspects-v1`, `__tests__/classifier.test.ts`, `IT-SNT-006` aspect view, golden g04/g14/g34 | PASS |
| UT-SNT-006 | Evidence resolution and Mixed dual evidence | `__tests__/classifier.test.ts` (16 tests): anchor ids resolve to the exact raw `start/end` slice decided by the code; unknown anchor → `evidence-unknown-anchor`; free-text `quote` or a non-id `anchorId` → `schema`; duplicate `(anchorId, polarity)` → `evidence-duplicate`; two polarities on one anchor outside Mixed → `evidence-anchor-polarity-conflict`; Mixed needs one positive + one negative; every rejection carries a bounded diagnostic naming the place, never the text | PASS (B7, C4, re-proven H2) |
| UT-SNT-007 | Deterministic top/bottom non-overlap and tie-breaks | `__tests__/metrics.test.ts` (`extremesAllocation`, code-unit tie-breaks) + `IT-SNT-007` + E2E-SNT-003 | PASS (B5 re-proven) |
| UT-SNT-008 | Adaptive buckets, null gaps, Top-6 roster and stable sorting | `__tests__/metrics.test.ts` + `IT-SNT-006` series | PASS |
| UT-SNT-009 | Selected-aspect sample metrics: S vs M vs C, `S/T` visibility, no Partial from an absent aspect | `__tests__/metrics.test.ts` (`B4` cases), Storybook `PriceAspect`, `IT-SNT-006` "B4" case, E2E-SNT-002 Price view | PASS (B4) |
| UT-SNT-010 | Input hash covers normalized body and every candidate identity in stable order | `__tests__/classifier.test.ts` (`B8`) | PASS (B8) |
| GOLD-SNT-001 | ≥40 synthetic labelled DE/EN cases; reference labels validate 100 %; evaluator gates | `golden/corpus.ts` (42 cases, 23 DE / 19 EN, 14 critical, polarity-labelled excerpts), `golden/reference.ts` (each excerpt must lie in exactly one anchor → anchored reference; the corpus is thereby a segmenter contract), `golden/evaluate.ts`, `__tests__/golden.test.ts` (6); live: `pnpm --filter @workspace/lib eval:sentiment-golden -- --live --max N` (paid, gated) | PASS offline (re-proven H1/H2); live at CP6 |
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
| UT-SNT-013 | H1 anchor segmenter: deterministic `{ id, start, end, text }` with ids `s0001…`, exact raw slices, ≤ `EVIDENCE_QUOTE_MAX_LENGTH`, full coverage of non-whitespace text (list markers recorded as markup), DE/EN sentence rules (abbreviations, dotted tokens, lowercase continuation, quotes/brackets), CRLF/CR/LF, Markdown, Unicode/emoji/surrogates, long spans split at punctuation → whitespace → hard cut, cap → `answer-unsegmentable`; same input → same anchors | `packages/lib/src/sentiment/__tests__/anchors.test.ts` (11) | PASS (H1) |
| CT-SNT-008 | H2 provider contract: the prompt renders the answer only as numbered segments and instructs citation by id; the strict JSON schema binds `anchorId` to `enum` of this answer's ids and carries no `quote`; both pinned byte for byte (prompt SHA-256 snapshot) | `__tests__/prompt-snapshot.test.ts` (2 + 3 snapshots), `classifier.test.ts` ("anchor-bound schema") | PASS (H2) |
| UT-SNT-014 | H3 paid-response envelope: OpenRouter reports `generationId`, request summary and numeric usage with the object; no content / invalid JSON / schema mismatch → typed `StructuredResearchResponseError` with the envelope and without the content; the classifier maps it and every post-response rejection to `SentimentValidationError` with `envelope` and `requestSent = true`; refusals before the request (`no-candidates`, `answer-unsegmentable`) carry `requestSent = false` | `providers/registry/openrouter.test.ts` (envelope tests), `__tests__/grounded-evidence.test.ts` (1, 5), `classifier.test.ts` | PASS (H3) |
| IT-SNT-001b | H3/H4 attribution and terminal policy in the job core: a rejected paid answer records exactly one `sentiment_classification_failed` event with the charged `actualCostUsd` (0.020047, not the estimate), a refusal before the request records nothing; the job completes with `terminal-validation-failure` (code, `requestSent`, diagnostic, envelope), the failed mark carries the exact input hash, a `failed` row with the current hash and a validation code is skipped without claim or call, another hash / a cleared hash / a non-validation code stays eligible; provider failures still throw `SentimentJobError` and clear the hash | `__tests__/job.test.ts` (32), `__tests__/grounded-evidence.test.ts` (2–4) | PASS (H3, H4) |
| IT-SNT-025 | H4 on real Postgres: one paid call → `failed` row with `input_hash` = current `sentimentInputHash`, `error_code` validation, `error_message` = safe message + ≤512-byte diagnostic, one failed usage event `estimated_cost_usd = 0.020047`, 0 observations; same input → job `skipped` (terminal), inventory `terminalFailed = 1`, never enqueued; changed answer → eligible; transient 503 → throws, `input_hash` null, next attempt classifies | `apps/web/src/server/__tests__/sentiment-pipeline.integration.test.ts` "IT-SNT-025" (3) | PASS (H4) |
| UT-SNT-DIAG / UT-SNT-LEAK | H5 bounded diagnostic: enumerated stage/reason, bounded ids and counts, largest admissible instance ≤ 512 bytes, free text refused in every field, hostile envelope sanitized to numbers and an opaque id; a poisoned provider driven through the real job core and canary leaves no answer text, prompt line, header or credential in the outcome, the analysis row, the usage event, the canary report or the console | `__tests__/diagnostics.test.ts` (5), `provider.test.ts`, `openrouter.test.ts` | PASS (H5) |
| CT-SNT-003b | Canary contract carries `evidenceVersion`; preflight refuses `contract-evidence-version`; `inspect` emits it; a rejected paid answer appears in the report as `terminal-validation-failure` with envelope and diagnostic, verdict `validation/<code>`, the row failed with the input hash and the charged cost attributed | `canary.test.ts` (59), `canary-*.test.ts`, `sentiment-canary-driver.test.ts` | PASS (H2–H5) |
| UT-SNT-015 | H1 RED→GREEN (round 5b): the classifier's safe generation id reaches the classified job outcome (`generationId`), the canary outcome and report; a successful canary is accepted only with one non-empty safe generation id — missing, empty, unsafe or non-string id → `generation-id-missing`, decided at the persistence boundary (analysis `failed`/`canary-contract`, nothing written); no database field added | `__tests__/generation-id.test.ts` (4; RED a6912e2c: 3 failures), `canary.test.ts` (`evaluateSentimentCanary` matrix), `job.test.ts` | PASS (H1) |
| UT-SNT-016 | H2 RED→GREEN (round 5b): `safeEnvelope` is a strict allowlist — `request` kept only when `model === SENTIMENT_MODEL` (any other value/type drops the whole summary, never a sliced string), counters (`inputTokens`, `outputTokens`, `reasoningTokens`, `webSearchRequests`, `maxToolCalls`, `maxOutputTokens`) only finite non-negative safe integers, `costUsd` only finite non-negative, flags only booleans, generation id only opaque, unknown fields ignored; hostile envelope with `sk-or-…`, `Bearer …`, answer and prompt fragments driven through the real job core (outcome, row, usage event, console) and the canary report leaves no trace | `__tests__/envelope-allowlist.test.ts` (5; RED 53699e50: 5 failures), `diagnostics.test.ts` | PASS (H2) |
| ST-SNT-001…003 | Storybook default/edge/evidence fixtures | `apps/web/src/stories/sentiment.stories.tsx` (11 stories incl. `PriceAspect`; offset-based highlight fixture); Storybook project 172/172 | PASS |
| E2E-SNT-001…006 | Route/sidebar/filter parity, URL state + stale `q`/`model`, expansion + lazy request + 10/10 + deep link, 375/768/1280/1400 + dark + focus + tooltip containment, regressions, SQL oracle | `e2e/tests/local/sentiment.spec.ts` (10 tests) | PASS |

## Traceability — SENT-CLASSIFIER-V4 (implementation + corrective round, PR pending)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| V4-RED-001 | Entity swap: an Arvo observation citing only Beltra anchors and vice versa is accepted by v3 (structurally valid); v4 refuses `evidence-entity-unbound` and accepts the correctly grounded labelling | `packages/lib/src/sentiment/__tests__/v4-grounding.test.ts` (RED commit f43c4aa8), `golden/v4-cases.ts` `v4-swap-de` | PASS |
| V4-RED-002 | Foreign-only evidence: an anchor naming another candidate but not the claimed one is refused with the anchor id in the diagnostic | `v4-grounding.test.ts`, `v4-foreign-only-en` | PASS |
| V4-RED-003 | Entity-unbound aspect: a price aspect citing only generic checklist bullets is refused `aspect-ungrounded`; a generic anchor beside a naming anchor stays admissible | `v4-grounding.test.ts`, `v4-checklist-de` | PASS |
| V4-RED-004 | Neutral descriptive statistics: case-count and usage statistics are labelled Neutral with no evaluative aspect (prompt/eval rule, not a lexical heuristic) | `golden/v4-cases.ts` `v4-stat-cases-de`, `v4-stat-usage-de`; prompt `SENTIMENT_ASPECT_ROUTING_RULES` | PASS |
| V4-RED-005 | Mixed structural mismatch: the wire schema cannot express Mixed without both polarities or a non-Mixed target with a contrary anchor; the local second boundary refuses `polarity-category-mismatch`; the same both-sides anchor may carry both polarities under Mixed; different aspects may carry opposite polarities | `v4-grounding.test.ts`, `provider-schema-v4.test.ts`, `classifier.test.ts`, `live-reproducers.test.ts` | PASS |
| V4-RED-006 | Aspect routing frozen in the prompt: deductible/self-retention, premiums, value → `price`; scope, limits, exclusions, waiting periods → `coverage`; claims handling, advice, digital service → `service`; `other` only for explicit evaluation; bare names/rankings/statistics never Positive/Negative `other` | `prompt.ts` `SENTIMENT_ASPECT_ROUTING_RULES`, `v4-grounding.test.ts`, `v4-huk-caveat-de`, `v4-table-en` | PASS |
| V4-RED-007 | Transition visibility: with only a completed v3 analysis present, the current-version-only read path made the run disappear once the constant moved to v4 (RED: fallback loader counted 4 instead of 5) | `apps/web/src/server/__tests__/sentiment-version-fallback.integration.test.ts` (RED f43c4aa8, 5/6 failing) | PASS |
| V4-RED-008 | Version coexistence fixtures: v3-only, v4-only, both, v3 + failed v4, v3 + pending v4, v2-only, stale taxonomy → exactly one analysis per run, v4 preferred, failed/pending v4 never hides v3, v2/stale excluded; overview, aspect view, series, coverage and Top/Bottom evidence agree; removing v4 restores the v3 fallback | `sentiment-version-fallback.integration.test.ts` (6, real Postgres) | PASS |
| CP3 | Provider request: discriminated `anyOf` per category, exact candidate-key and anchor-id enums emitted once under `$defs` and referenced from every branch (see V4-RED-009), `strict: true`, `require_parameters: true`, unchanged model / `max_tool_calls 1` / `max_tokens 8000`, only strict-subset keywords; compatibility guard rejects `if/then`, `contains`, `allOf`, `not`, `oneOf`, `patternProperties`; enum budget at the 400-anchor cap < 120 k chars | `provider-schema-v4.test.ts` (3), `prompt-snapshot.test.ts` (schema snapshot) | PASS |
| CP4 | Deterministic grounding guard shared by worker, canary, tests, backfill/reclassification (`validateClassification`): explicit mentions via detector terms; inheritance from table header (rows describe every header entity), colon list intro, list-item continuation, paragraph continuation, heading scope; stops at blank line, heading, table, another candidate; generic anchors never ground alone; fail-closed codes `evidence-entity-unbound`, `entity-ungrounded`, `aspect-ungrounded` with id/offset-only diagnostics; deterministic and order-independent | `grounding.ts`, `__tests__/grounding.test.ts` (12) | PASS |
| CP5 | Prompt rewritten (grounding, polarity-first, Mixed rule, aspect routing, statistics neutral, narrow `other`); v4 golden corpus of 12 labelled cases across 11 families + the 40-case v3 corpus still validating under v4 | `prompt.ts`, `golden/v4-cases.ts`, `v4-golden-cases.test.ts` (5), `golden.test.ts` | PASS |
| CP6 | Centralised selection `selectedSentimentAnalysisIds` / `sentimentRunCoverageStatus` in `@workspace/lib/sentiment/read-selection.ts`, used by every loader in `apps/web/src/server/sentiment-load.ts`; no version label added; v3 rows never deleted | `sentiment-version-fallback.integration.test.ts`, `sentiment-overview.integration.test.ts` | PASS |
| CP7 | v3/v4 cannot collide: completed v3 leaves the run eligible for v4, completed v4 does not; distinct singleton keys; stale payload skipped without a call; inventory reports `fallbackCompleted` and `neverClassified` beside `completed`/`terminalFailed`/`eligible`; canary contract versions come from the constants | `v4-coexistence.test.ts` (5), `backfill.ts`, `canary.test.ts` | PASS |
| CP8 | Restored-production shadow oracle (read-only copy): over 73 completed v3 analyses the guard detects `996deaca` (swap) and three further mis-groundings, rejects 4 generic-only v3 labellings by the rule the GO mandates and 16 category/evidence polarity mismatches the v4 contract forbids; 49 accepted; read selection selects 73/73 v3 before fixtures, replaces exactly the fixture runs, keeps v3 under a failed v4 and restores identically after removal, 0 double counts | `apps/worker/scripts/sentiment-grounding-shadow.ts`, `sentiment-selection-shadow.ts`; operator evidence (private) | PASS |
| V4-RED-009 | Provider enum budget: the schema sent for a 400-anchor answer carried the anchor-id enum once per evidence site (25 copies → 10,161 literal enum values; ≥ 36 anchors already exceeded the documented 1000-value limit; 2 of 73 production answers). Corrective D1: every reused part is one Zod instance, serialised once under `$defs` (`anchorId`, `entityKey`, `aspectKey`, `confidence`) and `$ref`erenced from every site; the request is refused before sending (`schema-budget-exceeded`, no provider call, terminal for this input) when the exact serialized schema breaks a limit | `schema-budget.test.ts` (1 / 35 / 36 / 38 / production max / 400 anchors; 2 / 12 / 416 / 500 competitors; real request body), `schema-budget.ts` verifier, `providers/json-schema.ts` single serializer | PASS (raw budget); dereferenced budget recorded as a risk — provider acceptance only provable by the max-schema canary |
| V4-RED-010 | G1 product-title list inheritance: bullets directly under an emphasised title line that names exactly one candidate inherit it (one hop; stops at prose, heading, table, another candidate mention, end of list; a title naming two or no candidates introduces nothing) | `grounding-narrow-context.test.ts` | PASS |
| V4-RED-011 | G2 clarifying-question inheritance: the paragraph directly after a one-line, one-sentence question naming exactly one candidate inherits it when the paragraph opens with a bounded DE/EN continuation form and names no other candidate (one hop, no chaining, blank/heading/list/table boundaries) | `grounding-narrow-context.test.ts` | PASS |
| CP8 (corrective) | Shadow oracle re-run on the same frozen restored cohort (73 completed v3): 50 accept / 23 reject — `polarity-category-mismatch` 16 (legacy wire shape, ledger PASS, expected incompatibility, visible via v3 fallback), `evidence-entity-unbound` 3 (`996deaca` swap, `24fda1eb`, `28cc88e5`), `aspect-ungrounded` 4 (`9c472bf5`, `29848bef`, `54227043`, `251e1a7a`); the five narrow false positives (`051ab35e` ×2, `1c152244` ×3) now accepted, 0 targets newly rejected, all 10 true positives still rejected, 0 accepted targets with foreign-only or all-generic evidence; intentional conservative rejections: 5 generic single-candidate targets (structurally identical to `9c472bf5`), 2 names-only-others (`28cc88e5`), 1 WEAK (`251e1a7a`) | `sentiment-grounding-shadow.ts`, operator evidence (private) | PASS |
