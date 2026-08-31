# Phase 1 — stage L user-checkpoint script (prepared at stage I, no real data yet)

Rehearsed on the synthetic test stack 2026-08-29..31 (bootstrap signup, onboarding submit, prompt editor, schedule controls — see feature-test-matrix.md). Real user data enters only after GATE-R4 = PASS.

## Checkpoint sequence for stage L (one action per block)

1. **Account** — user opens `http://127.0.0.1:1515/` (fresh instance redirects to `/auth/register`), enters name/e-mail/password themselves. Local mode allows exactly this one signup; afterwards registration closes (verified behavior). I verify: session works, `/app` reachable, unauthorized access redirects.
2. **OpenRouter key** — already in `%USERPROFILE%\.elmo\.env` (entered by user at stage H; the production stack reads the same file). No in-app credential UI exists in local mode — .env is the supported path. I verify: worker boots with the key, no value printed.
3. **Website + brand** — user submits their real website in `/app/new` (fields: Name, Website), completes the onboarding wizard (analysis → suggested domains/aliases/competitors/prompts → review). I verify: brand row exists, org membership correct.
4. **Competitors** — user reviews/edits at `/app/<brand>/settings/competitors`.
5. **Prompts** — user adds/imports prompts at `/app/<brand>/settings/prompts` (bulk paste supported, one per line) and leaves them **disabled** until validation.
6. **My metadata-only validation** (no prompt text in logs/reports) — queries below.
7. **Cost review** — I show: enabled_count × $0.011–0.012 × 30 ≈ monthly USD (recompute with then-current pricing). User decides.
8. **Explicit confirmation** → prompts enabled / schedule active.
9. I verify the first scheduled run, citations, dashboard update.

## Metadata-only prompt validation queries (run via docker exec psql on prod DB)

```sql
-- counts, duplicates, empties, lengths, tags, enablement — no prompt text
SELECT count(*) AS total,
       count(*) FILTER (WHERE enabled) AS enabled,
       count(*) FILTER (WHERE length(trim(value)) = 0) AS empty_values,
       count(*) FILTER (WHERE length(value) > 500) AS over_500_chars,
       count(DISTINCT lower(trim(value))) AS distinct_values
FROM prompts WHERE brand_id = :brand;
-- duplicate detector (returns only counts, not text)
SELECT count(*) FROM (
  SELECT lower(trim(value)) v, count(*) c FROM prompts
  WHERE brand_id = :brand GROUP BY 1 HAVING count(*) > 1
) d;
-- tag distribution
SELECT coalesce(array_length(tags,1),0) AS tag_count, count(*) FROM prompts
WHERE brand_id = :brand GROUP BY 1 ORDER BY 1;
```

Target association check: platform selections per brand at `/app/<brand>/settings/llms` must include only `chatgpt` (the sole SCRAPE_TARGETS platform in production config).

## Spend-control lesson from DEF-003 (binding for stage L)

`schedule-maintenance` (cron */5) expedites overdue prompt chains as soon as the worker sees them. Therefore in production: prompts stay disabled until checkpoint 8; the worker starts with the real key only after the user confirms budget; RUNS_PER_PROMPT=1 and DEFAULT_DELAY_HOURS=24 are set in the production .env before the worker ever starts.

## Confirmed: no real data needed before GATE-R4

Crash/recovery (stage J) and cold-boot acceptance (stage K) run entirely on the synthetic production-like stack with disposable fixtures.
