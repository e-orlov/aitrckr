# Production deployment plan — v0.3.0 candidate (rc1-a8747c20)

**Not executed. Requires explicit user authorization.** Production currently runs `g34057521` on volume `elmo_postgres_data`.

## Pre-deploy checklist

1. Read-only production snapshot (containers/images/StartedAt, HTTP, `health-elmo.ps1`) + fresh `pg_dump -Fc` of the prod DB to `%USERPROFILE%\.elmo\backups\` (outside Git) with control counts.
2. Confirm CI green on the deployed commit; confirm rc1 image IDs match the candidate manifest.
3. **[USER CHECKPOINT]** explicit deploy authorization.

## Deploy (Git Bash, repo root; expected downtime ≤ ~1 min)

```bash
export COMPOSE_FILE="$USERPROFILE/.elmo/elmo.yaml;docs/phase1/ops/prod-env.override.yaml"
export COMPOSE_PATH_SEPARATOR=";" COMPOSE_PROJECT_NAME=elmo
docker tag elmo-web:rc1-a8747c20 elmo-web:ga8747c20
docker tag elmo-worker:rc1-a8747c20 elmo-worker:ga8747c20
docker tag elmo-db-migrate:rc1-a8747c20 elmo-db-migrate:ga8747c20
node docs/phase1/ops/gen-prod-env.cjs "$USERPROFILE\\.elmo" ga8747c20   # preserves DEPLOYMENT_ID/keys incl. OpenRouter & encryption
docker compose up -d --no-build    # db-migrate applies 0016/0017 to the production DB, then web/worker recreate on new images
```

Post-deploy verification: `docker compose ps` healthy; web `http://localhost:1515` HTTP 200; control counts unchanged except migration columns/indexes; `brands.slug` NULL (URLs fall back to id — existing bookmarks keep working); watchdog next tick 0x0; **[USER CHECKPOINT]** dashboard visual check. Scheduled Tasks need no change (same ConfigDir/Project).

## Rollback (preferred: forward-compatible, proven in RC phase)

Old images run correctly against the migrated schema (read AND write proven on the prod copy). No DB downgrade needed:

```bash
node docs/phase1/ops/gen-prod-env.cjs "$USERPROFILE\\.elmo" g34057521
docker compose up -d --no-build
```

## Rollback, last resort (schema reversal — only if forward-compat fails in practice)

Rehearsed on a disposable copy. Take a fresh dump first; then:

```sql
DROP INDEX IF EXISTS citations_brand_created_analytics_idx;
CREATE INDEX idx_citations_brand_analytics ON public.citations USING btree (brand_id, created_at, url, domain, title, prompt_id, model);  -- exact original definition
DROP INDEX IF EXISTS brands_organization_id_slug_idx;
ALTER TABLE brands DROP COLUMN IF EXISTS slug;  -- loses only slugs set after deploy
DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2);
```

Then the image rollback above. Never `docker compose down -v` for project `elmo`.

## Explicitly out of scope until authorized

Production DB migration, container recreation on new images, any change to `%USERPROFILE%\.elmo`, Scheduled Tasks, or the running `g34057521` stack.

## Stage A readiness evidence (2026-09-01T19:10–19:25Z)

- Pre-deploy snapshot: same container/image IDs as manifest, StartedAt 2026-08-31T19:39:11Z, HTTP 200, tasks 0x0; volume `elmo_postgres_data`.
- **Schedule drift finding**: the 08:36-local shift did NOT hold — morning ticks were cadence no-ops (anchor = last real run), and today's due cycle was executed by maintenance-expedite at ~18:41Z (runs 27→54, citations 84→161, usage 27→54). Effective cycle time is ~20:36–21:06 local and will stay there; the created-queue is currently empty (singleton throttle) and maintenance revives it when prompts become overdue (~tomorrow evening). If the user still wants 08:36 local, the correct mechanism is a one-time manual "Run now" at 08:36 (anchors the cadence) — decide post-deploy, out of scope here.
- Image IDs re-verified: rc1 trio == candidate manifest; g34057521 trio == production manifest. No rebuilds/tags performed.
- Resources: C: 14.5 GB free, RAM 7.1/15.6 GB — sufficient (backup 424 KB; disposable restore verified then stopped).
- Fresh backup: `%USERPROFILE%\.elmo\backups\elmo-prod-pre-v030-20260901-191417.dump` (424,037 B, SHA-256 `4f9265f72403963cc8d84ebd9469d94141aade56fb64c6a48ef640a58735ada6`) + `.sha256` + `.counts.txt` (54 runs / 161 citations / journal 16 / queue empty). Restore proven on disposable `elmo_bkverify` in the stopped-again rc030 postgres: `pg_restore --list` 196 TOC entries, restore exit 0, counts identical, no worker attached.
- Config backup: `%USERPROFILE%\.elmo\backups\config-20260901-*/` (.env 833 B, elmo.yaml 1647 B, prod override 768 B; SHA-256 recorded; owner-only profile ACL).
- gen-prod-env rehearsal on a COPY (`%USERPROFILE%\.elmo-deploy-rehearsal`): images pinned `ga8747c20`, project `elmo`, loopback 1515 via override; DEPLOYMENT_ID / ELMO_ENCRYPTION_KEY / BETTER_AUTH_SECRET / OPENROUTER_API_KEY / RUNS_PER_PROMPT / DEFAULT_DELAY_HOURS / SCRAPE_TARGETS all hash-equal PRESERVED. Production ConfigDir untouched.

## Quiet-window execution plan

Window: any time before ~18:30Z (next cycle is maintenance-driven tomorrow evening; queue empty, active jobs 0). Expected downtime ≤ ~60 s (retag+regen are instant; compose recreates web/worker; 0016 is a fast ALTER, 0017 index build on 161 rows is sub-second).

1. Watchdog interaction: no disabling needed — the deploy runs between its 5-min ticks; if a tick lands mid-recreate, `compose up` on a healthy project is a no-op (proven in Phase 1 J9) and the ops-mutex serializes scripted actions. Perform the deploy right after a watchdog tick for maximal margin.
2. `docker tag` rc1→ga8747c20 (3 images); `node docs/phase1/ops/gen-prod-env.cjs "$USERPROFILE\.elmo" ga8747c20`; `docker compose up -d --no-build` (project elmo, standard COMPOSE_FILE pair).
3. db-migrate applies 0016/0017; web/worker recreate on ga8747c20; postgres container is NOT recreated (same image/config → volume untouched).
4. Health/data checks: compose ps healthy; HTTP 200 on localhost:1515; counts vs `.counts.txt` (unchanged besides schema); `brands.slug` NULL; both index states; watchdog next tick 0x0.
5. **Immediate-rollback criteria**: web not 200 within 3 min; worker crash-loop; db-migrate non-zero; any count mismatch; user-visible data loss on dashboard.
6. Rollback: forward-compatible — `gen-prod-env.cjs "$USERPROFILE\.elmo" g34057521` + `compose up -d --no-build` (schema stays migrated; proven compatible read+write). Schema reversal only as documented last resort.
7. [USER CHECKPOINT] dashboard visual verification concludes the cutover.

## Optional live-provider canary (RC stack, pre-cutover)

Purpose: one real `openai/gpt-5.6-luna:online` call through the RC worker against the RC database only, proving v0.3.0's provider path end-to-end before production runs it. Max expected cost: **≤ $0.02** (observed $0.005–0.012/run). Key handling: the user pastes the key manually into `%USERPROFILE%\.elmo-rc030\.env` (replacing the placeholder; file outside Git, never echoed); after the canary the line is reverted to the placeholder. Requires separate user authorization; skippable — CI/stub coverage plus Phase 1 live evidence may be deemed sufficient since the provider-call code path in v0.3.0 is unchanged (no diff in packages/lib providers beyond citation-title bounding).

## Live-provider canary result (user-authorized, 2026-09-01T19:59:44Z)

RC stack + RC database only; exactly one enabled prompt; queue empty at start. Outcome: **PASS** —

| Check | Result |
|---|---|
| Provider calls | exactly 1 (`usage_events` prompt_run count = 1) |
| New prompt_run | 1: provider `openrouter`, model `chatgpt`, version `openai/gpt-5.6-luna`, `web_search_enabled=true` |
| Response | non-empty (raw_output 7,908 chars; content not recorded here) |
| Citations | 2 new; titles present, max length 52 (v0.3.0 title bounding in effect), none empty |
| Worker errors | 0; run completed 1/1, next run rescheduled +24h |
| Actual cost | **$0.0050** (≤ $0.02 budget) |

Key hygiene: key entered by the user directly into `%USERPROFILE%\.elmo-rc030\.env`; after the canary the worker container was stopped AND removed (no key in any container config), the placeholder line was restored, and scans show 0 key patterns in the RC `.env` and worker logs (value never read or printed). RC containers stopped again; production untouched throughout.

## Cutover execution record (2026-09-01, user-authorized)

Pre-checks at 20:03:36Z all green (active jobs 0, nothing due ≤2h, backup SHA-256 MATCH, config backup present, 3 RC image IDs == manifest, prod 200). Started immediately after the 20:05:05Z watchdog tick (0x0). GO 20:05:59Z → compose up done 20:06:10Z (**downtime ≈ 11 s**).

- Retag rc1→ga8747c20 (3 images); gen-prod-env preserved all values ("key preserved"); `docker compose up -d --no-build` exit 0.
- db-migrate exit 0, 0 errors; drizzle journal 16→18 (exactly 0016+0017). PostgreSQL container/volume NOT recreated (StartedAt unchanged, Up 25h).
- web/worker on `ga8747c20`; HTTP 200; health-elmo.ps1 HEALTHY exit 0.
- Data: counts 1/1/27/54/161/54 unchanged; `brands.slug` NULL with id-fallback; old citations index dropped, new present.
- Config: all 7 protected values hash-equal PRESERVED vs config backup. No unplanned worker cycle (runs stayed 54); 0 errors/secret patterns in web+worker logs; Scheduled Tasks untouched; post-deploy watchdog tick 22:10:10 local = 0x0.
- Rollback NOT needed; `g34057521`, RC images, backups, dump and prodlike volume all retained (no prune).
- **User visual acceptance 2026-09-01: login, org/brand dashboard, Prompts, Citations, Analytics, Settings — «всё на месте».**
