---
"@workspace/lib": patch
"@workspace/worker": patch
---

The five-minute maintenance job now evaluates ten sentiment dispatch alert signals from the database (contract defects, open breakers, failed probes, refusals across request shapes, provider credential/credit refusals, awaiting-review and held-backlog growth, stranded and reservation-blocked permits, gate breaches) with database-clock windows and cooldowns, captures the awaiting-review baseline from the existing rows at its first tick under a held dispatch, and writes a durable heartbeat only after every stage succeeded; operators get `control:sentiment status --json` (versioned contract, exit codes 10/20/30/40) and `control:sentiment alert list|ack` with compare-and-set, audited acknowledgement.
