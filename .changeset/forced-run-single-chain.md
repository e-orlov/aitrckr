---
"@workspace/lib": patch
"@workspace/web": patch
"@workspace/worker": patch
---

An admin-forced prompt run no longer creates a duplicate schedule or silently stops the prompt's cadence chain, and forced runs get the same 90-minute job timeout as scheduled runs.
