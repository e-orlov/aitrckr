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

## Consequences

- Runs that v4 rejected for an aspect-only defect complete under v5 with the aspect dropped; runs with an overall defect remain terminal.
- The Sentiment page needs no change: aspect metrics use persisted aspect rows only, an absent aspect is simply absent, and the existing coverage cue (`classified < mentions`) keeps its meaning.
- The prompt states that aspects are optional findings, not a checklist, and that an omitted aspect is the correct answer when the text does not evaluate it for the entity.
