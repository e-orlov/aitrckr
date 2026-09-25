# Sentiment Flex rollout

OpenRouter Flex changes capacity and token pricing for the existing `openai/gpt-5-mini` sentiment calls. It does not change prompts, web search, schemas, model, classifier version or stored input hashes. A tariff change alone does not justify a historical backfill.

The worker uses normal routing by default. `SENTIMENT_OPENROUTER_SERVICE_TIER=flex` opts only sentiment classification, repair and verification into Flex; other OpenRouter research stays on its current route. The request profile scopes permits and the circuit breaker separately by tier. [OpenRouter routing](https://openrouter.ai/docs/guides/features/service-tiers) may return a capacity error rather than fall back to standard capacity when Flex is pinned.

## Functional gate

1. Deploy with the variable unset. Choose a **pristine**, representative run that mentions a tracked brand and has a settled answer. With `SENTIMENT_OPENROUTER_SERVICE_TIER=flex` in the worker environment, run `pnpm -C apps/worker canary:sentiment inspect <run-id>` and freeze its exact output as the contract. Keep its SHA-256 as required by the existing canary driver.
2. In the same environment, run `pnpm -C apps/worker canary:sentiment run --contract <file> --contract-sha256 <hex> <run-id>`. An accepted verdict means the production job classified and independently verified the candidate within the existing cost and 120-second canary limits. The report must show `request.serviceTier=flex`, `servedServiceTier=flex`, and `servedServiceTiers` containing `flex` for **every** provider call. Reconcile the reported generation ID and charged total with the OpenRouter ledger. Review the evidence and category as usual before wider traffic.
3. Enable the variable for the worker only after the live canary passes. Watch cost per completed answer, `retry_wait`, `awaiting_reconciliation`, `awaiting_review`, and run latency. If capacity or latency harms completion, unset the variable and restart the worker. Completed analyses stay completed; do not enqueue a backfill or bump the classifier version for this switch.

The current canary deadline is 120 seconds and the worker claim/queue window is 15 minutes. A Flex result exceeding these limits is a failed rollout gate. Lengthening them requires a separate review of duplicate-call prevention and reconciliation. A provider refusal without a known typed, output-free error stays parked for reconciliation, so Flex capacity failures must be observed before wider rollout.
