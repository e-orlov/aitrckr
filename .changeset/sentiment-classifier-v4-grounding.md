---
"@workspace/lib": patch
"@workspace/web": patch
"@workspace/worker": patch
---

Sentiment classification now binds every cited excerpt to the entity it judges, rejects verdicts whose evidence contradicts the category, treats statistics as neutral, and keeps existing results visible until they are reclassified.
