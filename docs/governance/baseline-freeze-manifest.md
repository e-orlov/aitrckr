# Baseline freeze manifest — Phase 1 production (2026-08-31)

Frozen 2026-09-01 by Phase 1.1. Release immutability was enabled repo-wide **before** publishing (API: `PUT /repos/…/immutable-releases` → 204; `GET` → `enabled=true`), so the tag, assets and prerelease flag of this release are locked by GitHub.

## Source baseline

| Item | Value |
|---|---|
| Baseline tag | `baseline/phase1-production-2026-08-31` (annotated; tag object `5cdecb967bc8dd9acd654351978513a9f954f939`) |
| Tag target (fork `main`) | `ff23fda683f16f150e00bd65aa133f6a9f0d96ce` |
| GitHub Release | https://github.com/e-orlov/aitrckr/releases/tag/baseline/phase1-production-2026-08-31 — published, `prerelease=false`, `immutable=true`, asset `SHA256SUMS.txt` |
| Latest-flag deviation | `make_latest=false` was requested at publish and re-applied via PATCH, but GitHub designates the sole published release of a repo as "Latest" (`isLatest=true`); the flag will shift automatically to the next ordinary release. Recorded as accepted platform behavior. |
| Production build commit | `340575215b814fc1afc43d2d830ac0d431ac5826` |
| Build-commit ref recovery | held on GitHub as `refs/pull/1/head` (`7ab63266…`, build commit is its ancestor) and offline in the git bundle as explicit `refs/archive/build-commit` |
| Docker-context equivalence | `git diff --name-only 34057521 ff23fda6` = 13 files, all under `docs/phase1/`; `.dockerignore` excludes `.env*`, `docs`, `e2e` → identical image build context |

## Runtime images (exact production identities)

| Ref | Full image ID |
|---|---|
| `elmo-web:g34057521` | `sha256:8033bfb4b0ff6e492d05376c5f1da88f559156ecabaa17a8f420f5ea916255cc` |
| `elmo-worker:g34057521` | `sha256:5bdf8185e7031b966c90054ae51ca40a52c1d6e6870af61d4539366efc4d5573` |
| `elmo-db-migrate:g34057521` | `sha256:a31ef76c3a5aa4625b88207d981db5785c847f90655057d3283032ea1b9f15c3` |
| `postgres:18-alpine` | digest/ID `sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2` |

## Offline archives (location placeholder: `<OneDrive>\ELMO-Baselines\phase1-production-2026-08-31\`)

| File | SHA-256 | Size (bytes) |
|---|---|---|
| `elmo-phase1-production-images-2026-08-31.tar` | `f1c62f6676eb6847b69246f436f994609544dce3b50380eaac1011edf06de860` | 496,995,328 |
| `elmo-phase1-baseline-2026-08-31.bundle` | `ec6559c653c655b462211f87009c9c262a462914920d3d12c5c2de6c3515bf0c` | 12,410,354 |

Plus `SHA256SUMS.txt` (mirrored as the release asset) and machine-readable `checksums.json`.

- Image tar: single deduplicated `docker image save` of all four images (OCI layout, compressed layers; `manifest.json` lists exactly the four refs above). Verified readable via `tar -t` + manifest parse. **No `docker load` was performed against the production daemon.**
- Git bundle refs: `refs/archive/main-baseline=ff23fda6`, `refs/archive/build-commit=34057521`, `refs/archive/pr1-head=7ab63266`, `refs/tags/baseline/phase1-production-2026-08-31`. `git bundle verify` = complete history; both commits proven restorable via a disposable temp clone (`git cat-file -t` → `commit`).

## Explicit exclusions

No `.env` files, no secrets, no production database volume/data. Pre-archive scan: image `Config.Env` contains only stock variable names (PATH/NODE_*/PG_* etc.); image history has zero secret-indicator matches; ephemeral `--network none` container scan found no `.env*` files inside the web image; `.dockerignore` excludes `.env*` from all build contexts.

## Restore outline (disposable environment only)

1. Verify checksums against `SHA256SUMS.txt`.
2. `docker load -i elmo-phase1-production-images-2026-08-31.tar` **in a disposable Docker environment**, never the production daemon.
3. `git clone elmo-phase1-baseline-2026-08-31.bundle` and check out `refs/archive/main-baseline` (repo state) or `refs/archive/build-commit` (image source).
4. Regenerate config via `docs/phase1/ops/gen-prod-env.cjs` (secrets must be re-entered by the operator — they are intentionally absent from the freeze).

## Limitations

- Exact data-state recovery is **not** claimed: the database volume is excluded; VM backups remain the administrators' responsibility.
- Production before/after evidence for this freeze: read-only snapshots at `%USERPROFILE%\.elmo\phase11-evidence\` (`prod-before.txt`, `prod-after-freeze.txt`).
