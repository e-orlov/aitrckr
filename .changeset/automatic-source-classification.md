---
"@workspace/lib": patch
"@workspace/web": patch
"@workspace/worker": patch
---

Automatically classify unknown citation sources: hostnames the built-in rules leave in "Other" are resolved asynchronously to Editorial or Institutional by an LLM once per domain, and the cached result is used across the dashboard and prompt details.
