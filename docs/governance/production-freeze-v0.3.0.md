# Production release freeze — upstream v0.3.0 (2026-09-01)

Freeze of the deployed-and-accepted production state. Production runtime untouched during this phase (read-only checks only).

## Frozen state

| Item | Value |
|---|---|
| Deployed/accepted production closeout commit (tag target) | `95b5dea800e523bb55f683513390edf3f7774d5d` |
| Application source of the running images | `a8747c20c94c9f0acfeaa60f8ad756af4444b1d8` (upstream v0.3.0 merge; the docs-only commits between it and final main are excluded from the Docker build context) |
| Production images | `elmo-web:ga8747c20` `0c6451dfb7e4…`, `elmo-worker:ga8747c20` `8d51e8da67dc…`, `elmo-db-migrate:ga8747c20` `368b6f593a62…` |
| PostgreSQL | `postgres:18-alpine` @ `sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2` (unchanged since Phase 1) |
| Migrations journal | 18 (…, 0016_brand_slugs, 0017_citations_analytics_index) |
| Rollback | forward-compatible to `g34057521` (images retained; procedure in docs/governance/rc030/deployment-plan.md) |
| Planned tag | annotated `production/upstream-v0.3.0-2026-09-01` → **`95b5dea800e523bb55f683513390edf3f7774d5d`** (the deployed/accepted closeout commit). The freeze PR’s own squash commit is a documentation/freeze-record commit only and is NOT the tag target |

## Recovery archive (private, off GitHub)

Location placeholder: `<OneDrive>\ELMO-Releases\production-upstream-v0.3.0-2026-09-01\`

| File | SHA-256 | Size (bytes) |
|---|---|---|
| `elmo-production-v0.3.0-images.tar` | `85eb20bad3a095eedc45df82fc7c4f03fa95e655e32610b52db4cdc9115fb3ae` | 380,162,560 |
| `elmo-production-v0.3.0.bundle` | `952c6d73b81e3f55c2ad82e363bc3e4c891208974048d9f9394def5dcfe9ab75` | 12,625,097 |

- Image tar: exactly the three `ga8747c20` images (verified via `manifest.json`). The pinned PostgreSQL image is deliberately **not** duplicated: it is already preserved in the verified Phase 1 baseline archive `elmo-phase1-production-images-2026-08-31.tar` (SHA-256 `f1c62f66…de860`, same OneDrive root, `ELMO-Baselines\…`).
- Git bundle refs: `refs/archive/prod-v030-main` = final main, `refs/archive/prod-v030-source` = a8747c20, plus the phase-1 baseline tag; both commits proven restorable in a disposable clone.
- Excluded by design: API keys, `.env`, config backups, production DB dumps (those live only in `%USERPROFILE%\.elmo\backups\`).

## Recovery instructions (disposable environment first, then production)

1. Verify checksums against `SHA256SUMS.txt`.
2. `docker load -i elmo-production-v0.3.0-images.tar` (+ postgres from the baseline archive if absent locally).
3. `git clone elmo-production-v0.3.0.bundle` → check out `refs/archive/prod-v030-main` for repo state (ops scripts, overrides) or `prod-v030-source` for image source.
4. Regenerate config with `docs/phase1/ops/gen-prod-env.cjs <configDir> ga8747c20` — secrets must be re-entered by the operator (never archived).
5. Restore data from the operator's DB backup (`%USERPROFILE%\.elmo\backups\elmo-prod-pre-v030-*.dump` predates 0016/0017: run db-migrate after restore; post-deploy dumps, when taken, restore as-is).
6. Standard startup: compose files per production-manifest.md; Scheduled Tasks via elevated `install-tasks.ps1 -TaskUser "<DOMAIN\user>"`.

## Planned GitHub governance (to apply only after user confirmation)

- Tag ruleset `production-tags-protection`: target `refs/tags/production/**`, active, rules deletion + update + non_fast_forward (mirrors `baseline-tags-protection`).
- Release on tag `production/upstream-v0.3.0-2026-09-01`: title **Production deployment — upstream v0.3.0 (2026-09-01)**, immutable (repo-wide immutability already ON), `prerelease=false`, **`make_latest=true`** (this IS the current production version — supersedes the phase-1 baseline as Latest, resolving the earlier documented deviation), asset: `SHA256SUMS.txt` only.
