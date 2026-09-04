---
"@workspace/lib": patch
"@workspace/web": patch
"@workspace/worker": patch
---

Every prompt-run job now uses one policy — a 90-minute ceiling and no automatic queue retry of a paid run — regardless of how it was created, and the queue itself is converged to the same defaults.
