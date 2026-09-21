---
"@workspace/lib": patch
"@workspace/worker": patch
---

Sentiment classification gains an operator-controlled dispatch hold (held by default after upgrade), per-lifecycle permits as the only bypass, a circuit breaker that stops requests the provider or the local schema guard deterministically refuses, and durable retry handling that never calls the provider before a case is due; operators get `control:sentiment` and `resume:sentiment` commands to inspect and steer it.
