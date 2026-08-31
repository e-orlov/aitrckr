# Windows VM runbook — Elmo fork (aitrckr), Phase 1

Target machine: Windows 10 Pro 22H2 (19045), 16 vCPU, 15.6 GB RAM, WSL2 + Ubuntu-24.04 (systemd). User: non-elevated domain account. All URLs loopback-only; no public exposure.

## Installed toolchain (verified versions, 2026-08-29)

| Tool | Version | Install method | Notes |
|---|---|---|---|
| Node.js | 24.16.0 | pre-existing (Program Files) | matches `engines` |
| pnpm | 11.18.0 | corepack per-user shims: `corepack enable --install-directory %LOCALAPPDATA%\corepack-shims` + user PATH | `corepack enable` into Program Files needs admin — use the per-user directory. In Git Bash add PATH via `cygpath -u "$LOCALAPPDATA"` |
| GitHub CLI | 2.98.0 | `winget install --id GitHub.cli --scope user` | auth: `gh auth login` web flow; token in Windows keyring |
| Docker Desktop | 4.88.1 (engine 29.7.2, Compose v5.4.0) | official installer, `install --user --backend=wsl-2 --no-windows-containers --quiet` | per-user, no admin needed (WSL2 pre-enabled); binaries `%LOCALAPPDATA%\Programs\DockerDesktop`; CLI on PATH via `resources\bin` |
| Playwright browsers | per workspace | `pnpm exec playwright install` (root) AND `pnpm -C e2e exec playwright install chromium` (e2e pins its own version) | |

Docker Desktop settings: terms accepted at first launch, no Docker account; `%APPDATA%\Docker\settings-store.json` → `EnableDockerAI:false`, `DisableUpdate:true`; Kubernetes/TCP-2375/beta = off (defaults); Resource Saver default (only pauses at 0 running containers ≥5 min — reassessed at stage J/K).

## Git

- Remotes: `origin`=e-orlov/aitrckr, `upstream`=elmohq/elmo. Work in feature branches, PR to origin main; never push main.
- Repo-local: `core.autocrlf=false` (MANDATORY on Windows clones — Biome requires LF; see DEF-002 in baseline-report.md), user.name/email set locally.
- Master prompt file is excluded via `.git/info/exclude` — never commit it.

## Environments

| Env | How it runs | Web | Postgres | Compose project | Volume | Config |
|---|---|---|---|---|---|---|
| dev | host `pnpm dev` + standalone pg container | localhost:3000 | 127.0.0.1:5432 (`aitrckr-dev-postgres`, db `elmo_dev`) | n/a (single container) | `aitrckr-dev-pgdata` | repo `.env` + `apps/web/.env` (dev placeholders) |
| test | Docker stack built from local source | 127.0.0.1:3999 | 127.0.0.1:5433 | `aitrckr-test` | `aitrckr-test_postgres_data` | `e2e/.elmo/` (gitignored; regenerate with `node docs/phase1/ops/gen-test-env.cjs`) |
| production (stage L) | Docker stack, images pinned to verified commit | 127.0.0.1:1515 | not published to host | `elmo` (CLI-native name) | own named volume | `%USERPROFILE%\.elmo` (outside repo) |

postgres:18-alpine note: mount the volume at `/var/lib/postgresql` (parent), not `/var/lib/postgresql/data` — the child mount silently lands the cluster in an anonymous volume.

### Dev commands

```bash
docker start aitrckr-dev-postgres    # if stopped
pnpm dev                             # web :3000 + worker (reads apps/web/.env)
pnpm lint && pnpm test && pnpm build
```

### Test stack commands (Git Bash, from repo root)

```bash
export PATH="$PATH:/c/Users/orlov/AppData/Local/Programs/DockerDesktop/resources/bin"
export COMPOSE_FILE="e2e/.elmo/elmo.yaml;e2e/worker-override.yaml;docs/phase1/ops/test-env.override.yaml"
export COMPOSE_PATH_SEPARATOR=";" COMPOSE_PROJECT_NAME=aitrckr-test
docker compose build                          # images from local source
docker compose up -d --no-build web           # web + db-migrate + postgres
bash e2e/wait-for-web.sh http://localhost:3999/
( cd e2e && DATABASE_URL="postgres://postgres:postgres@localhost:5433/elmo" pnpm exec tsx seed.ts )
BASE_URL=http://localhost:3999 DATABASE_URL="postgres://postgres:postgres@localhost:5433/elmo" pnpm -C e2e exec playwright test --project=local
( cd e2e/bruno && ../node_modules/.bin/bru run -r --env local --env-var baseUrl=http://localhost:3999 )
docker compose up -d --no-build worker        # stub provider via worker-override — no paid calls
BASE_URL=http://localhost:3999 DATABASE_URL="postgres://postgres:postgres@localhost:5433/elmo" pnpm -C e2e exec playwright test --project=worker
docker compose stop worker                    # protect seeded fixtures
```

The worker override pins the worker to `SCRAPE_TARGETS=stub:stub`; the test stack never calls paid providers.

## Known issues / operational notes

- **DEF-001**: Docker Desktop stop→start can crash on a stale `%LOCALAPPDATA%\docker-secrets-engine\engine.sock`. Recovery: kill leftover docker CLI processes, rename `docker-secrets-engine` aside, start Desktop. Stale renamed dir is deletable only after reboot.
- Disk: C: at ~75%; Docker build cache ~11 GB reclaimable. Do not prune automatically — ask the user (`docker builder prune`).
- MS Store Python virtualizes `%APPDATA%` writes — use `node` for editing files under AppData, not `python`.
## Production (stage L)

Deployment details, versions and pinned images: `production-manifest.md`. Ops scripts: `docs/phase1/ops/` (start/stop/health/watchdog/install-tasks/remove-tasks; all take `-ConfigDir`/`-Project`, defaults = production).

```bash
# status / logs / restart (Git Bash, from repo root)
export COMPOSE_FILE="$USERPROFILE/.elmo/elmo.yaml;docs/phase1/ops/prod-env.override.yaml"
export COMPOSE_PATH_SEPARATOR=";" COMPOSE_PROJECT_NAME=elmo
docker compose ps
docker compose logs --tail 50 web worker
docker compose restart worker
```

```powershell
# controlled start/stop/health (PowerShell, defaults point at production)
powershell -NoProfile -ExecutionPolicy Bypass -File docs\phase1\ops\start-elmo.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File docs\phase1\ops\health-elmo.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File docs\phase1\ops\stop-elmo.ps1   # containers only; add -IncludeEngine for Desktop
```

Deploy and rollback: see `production-manifest.md`. Auto-start: Scheduled Tasks (S4U) — reinstall with elevated `install-tasks.ps1`, remove with `remove-tasks.ps1`. Watchdog handles engine-down (incl. DEF-001) and unhealthy services every 5 minutes.
