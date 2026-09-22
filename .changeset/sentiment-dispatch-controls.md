---
"@workspace/lib": patch
"@workspace/worker": patch
---

Sentiment classification gains an operator-controlled dispatch hold (held by default after upgrade), per-lifecycle permits as the only bypass (verify-only and manifest-bound for resuming parked cases, expiring durably so a replacement can always be issued), a circuit breaker that stops requests the provider or the local schema guard deterministically refuses and counts every concurrent strike, a final re-authorization of every request at the provider boundary, and durable retry handling that never calls the provider before a case is due; a verifier that rejects a resumed case hands it to human review; operators get `control:sentiment` and `resume:sentiment` commands to inspect and steer it.
