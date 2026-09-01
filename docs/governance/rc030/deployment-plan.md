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
