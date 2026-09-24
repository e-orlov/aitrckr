# Sentiment dispatch alert runbooks (ADR-SENT-01 Amendment D)

Every alert carries its `signal`, `scope`, `severity`, `reason`, `observed`, `threshold`, `runbook` and a stable `digest`. Inspect with `pnpm -C apps/worker control:sentiment status --json` (contract v1) or `alert list --json`; acknowledge with `alert ack <rowKey> --expected <observedDigest> --actor A --reason R --correlation C`. No alert ever changes dispatch, a breaker or a permit: every action below is the operator's.

| runbook | signal | severity | what it means | first response |
|---|---|---|---|---|
| RB-1 | `first-contract-defect` | urgent | a case entered `awaiting_review/contract-defect` outside the captured baseline | `status`; read the attempt ledger of the named analyses; check `breaker list` (a class-1/2 refusal should have opened a scope); decide corrective PR vs `resume:sentiment verify`; acknowledge the digest once triaged |
| RB-2 | `breaker-open` (per request-profile scope) | urgent | the scope refuses requests deterministically | `breaker list`; if the shape is a contract defect → corrective PR; after the cause is fixed `breaker reset <scope>` (to half-open only; there is no force-close) |
| RB-3 | `probe-failed-or-expired` (per scope) | urgent | the half-open probe was refused again, or its lease passed without an outcome | check worker restarts (`docker inspect` RestartCount); reconcile the probe attempt if it is `sending`; `breaker reset` only once the cause is understood |
| RB-4 | `refusals-across-shapes` | urgent | class-2 refusals in ≥ 2 distinct request-profile scopes within 24 h (D8) | not a single schema: suspect adapter/guard or provider-side change; keep dispatch held; open an incident |
| RB-10 | `provider-refusal-config` (provider·model·status) | urgent | the provider answered 401/402/403 | check credentials, credit and model permissions on the provider account; keep dispatch held until a valid capped smoke request succeeds |
| RB-5 | `awaiting-review-growth` | informational | new unacknowledged review cases beyond D9 (`approximate: true` above 5,000 open ids) | triage the queue; adjudicate or schedule a resume batch; `alert ack` with the printed digest |
| RB-6 | `held-backlog-growth` | informational | held work ≥ 20 items or oldest ≥ 48 h (D10) | confirm the hold is intentional; plan OPEN GO or a `release-held` batch |
| RB-7 | `permit-exhausted` (per permit; urgent for an unverified canary) | informational | a permitted lifecycle is stranded (`phase-budget-exhausted` / `active-expired-unresolved`) | reconcile the attempts; issue a new permit only after review |
| RB-11 | `reserve-exceeded` (per permit) | informational | a still-required phase cannot satisfy `settled + reserved + R_next ≤ budget` — reservations are planning estimates, not price ceilings | decide whether to revoke and reissue with a larger planning budget or to leave the lifecycle for review |
| RB-8 | `gate-breach` (per occurrence) | urgent | the boundary guard refused a request an earlier gate should have stopped | this is a code defect: dispatch stays held, file a corrective |
| RB-9 | `alert-delivery-failure` | urgent | heartbeat stale or status not executable — decided by the host watchdog (F2-PR-3), never by the worker | check the worker container and the database; the heartbeat row (`maintenance_heartbeat`) shows the last complete tick |

## Status exit codes (contract v1)

`0` healthy · `10` dispatch held and nothing worse · `20` an urgent alert is active (unacknowledged) · `30` the maintenance heartbeat is missing or older than 15 minutes · `40` the status could not be produced. Precedence `40 > 30 > 20 > 10 > 0`. CLI-wide `1` error, `2` usage, `3` refused (a compare-and-set acknowledgement whose digest no longer matches).
