# F-06 Corrective R1 — final closeout integrity

Status: **PASS / CLOSED** 2026-09-06. This addendum corrects the F-06 closeout record; it accompanies **no application change, no image build and no deployment**. The original closeout (`f06-owned-citation-structure-closeout.md`) and the original immutable tag/release stay as written. Raw evidence lives outside Git under the operator's private `~/.elmo/f06-corrective-r1-evidence/`.

## Lineage

| Item | Value |
|---|---|
| F-06 pre-feature main | `e599fc689627428da3367e1df43b9c85b59bb8ec` |
| F-06 application source (image source, unchanged) | `48e697837045c585ffaf32d821dcf601f841ab5d` — [#21](https://github.com/e-orlov/aitrckr/pull/21) squash |
| F-06 closeout (docs) | `9bc5ba89362078f2ff1535eaa065af72596fc9bd` — [#22](https://github.com/e-orlov/aitrckr/pull/22) squash; tag `production/f06-owned-citation-structure-2026-09-06` (object `cb04a570…`, peeled `9bc5ba89…`), release Immutable, `SHA256SUMS.txt` reconciles with `D:\ELMO-Recovery\F06-OwnedCitationStructure-20260906` (dump, images tar, bundle all `sha256sum -c` OK) |
| Corrective R1 implementation (operational/test-only, **not an image source**) | `39276776fb074e241a249c0e640ac783653c7ffe` — [#23](https://github.com/e-orlov/aitrckr/pull/23) squash |
| Final closeout (docs only, **not an image source**) | the commit carrying this file |
| Running production images (unchanged, re-verified read-only) | `elmo-web:g48e69783` `sha256:6891e26bc69f44b24978e552e22365384613a96f1d0b61ae55d10275deca766c` · `elmo-worker:g48e69783` `sha256:8842d34fe941fb18c0bbf5168d80f77b3635f922eed77390fa3227e02e6c0459` · `elmo-db-migrate:g48e69783` `sha256:167d86d1c39beb54fa50fe7a7a625a6ee7a2c6235e70b9c091a0a46264c1a07f`; web/worker started 2026-09-06T11:12:36Z, restarts 0; postgres container started 05:26:57Z, volume `elmo_postgres_data` from 2026-08-31 |
| Immediate rollback trio (unchanged) | `elmo-web:g4f30f53e` `sha256:2ae5f5cb013f…`, `elmo-worker:g4f30f53e` `sha256:01191f72864d…`, `elmo-db-migrate:g4f30f53e` `sha256:244e60d21d24…` |
| Migration journal | 20 before, during and after |

## The three discrepancies

1. **Config regeneration.** The manifest said regeneration "preserves every existing key"; `gen-prod-env.cjs` actually rewrote `.env` from its own defaults, carrying over only `DEPLOYMENT_ID`, `BETTER_AUTH_SECRET`, `ELMO_ENCRYPTION_KEY` and `OPENROUTER_API_KEY`. Reproduced in a `mkdtemp` directory with synthetic values: `.env` sha256 `b8f04419…` → `03291984…`; `SCRAPE_TARGETS`, `APP_URL`, `VITE_APP_URL`, `RUNS_PER_PROMPT`, `DEFAULT_DELAY_HOURS` reset to defaults, an operator-added key dropped. Production was never affected only because its values equal the generator defaults (17-key hash comparison at the F-06 cutover); the F-06 rehearsal did hit it (stub target reset, recorded there).
2. **Two "pre-existing Windows-only" test exceptions** stood in for a green suite. Reproduced on the untouched `9bc5ba89` tree: `scripts/check-server-bundle.test.mjs` 7/8 (`_ssr\footer.mjs` reported vs `/_ssr\/footer\.mjs/` expected — detection itself worked, the real `check-server-bundle.mjs apps/web` exited 0); Storybook `cloud-billing › Annual Billing Shows Annual Total` failed on the de-DE desktop (`$3.090` rendered vs `"$3,090"` expected). Neither was a server-bundle leak or a billing defect.
3. **Wording.** The closeout said "production data writes introduced: 0" and "no data written" while also recording a minted and deleted session row.

## Corrections (PR #23)

- `docs/phase1/ops/gen-prod-env.cjs`: an existing `<configDir>/.env` is operator-owned state — never rewritten, reordered or re-quoted; the required keys are checked for presence exactly once (missing / duplicate / malformed line ⇒ fail closed before any write, naming keys and line numbers only); only `elmo.yaml` is regenerated (temp file + rename) with the explicit tag. First run unchanged (fresh secrets, provider placeholder, nothing secret printed). Refuses empty, filesystem-root, home and workspace-root targets and the floating tag `latest`.
  `scripts/gen-prod-env.test.mjs` CFG-01…CFG-15 + target refusal: baseline 5/15 → 16/16 (`node:test`, `mkdtemp`, synthetic values, no dependency).
- `scripts/check-server-bundle.mjs` reports findings with forward slashes on every platform; tests add nested paths, native/forward-slash app-dir spellings and a database-driver negative case (`pg`, `drizzle-orm/node-postgres` must still fail). 7/8 → 10/10; the same forbidden requires still exit 1; `apps/web` check exits 0.
- `apps/web/vitest.config.ts` pins the Storybook browser context to `locale: "en-US"` (override `STORYBOOK_BROWSER_LOCALE`); the billing story asserts the locale-formatted total for 3090 followed by `/year`. 12/12 under en-US and de-DE; the old assertion still fails under de-DE. Production billing rendering unchanged.

## Verification

Local (Windows VM, node 24.16.0, pnpm 11.18.0, de-DE browser): lint 702 files / 0 · check-types 13/13 · unit lib 633, web 433, config 93, cloud 43, cli 28 · `node --test scripts/*.test.mjs` 30/30 · Storybook **123/123** · `pnpm build` 16/16, clean tree · license check 1,260 compliant · Playwright `local` 89 passed / 2 established worker-gated skips (incl. `citation-structure.spec` 5) · `check-server-bundle.mjs apps/web` rc 0 · client assets free of database code. **No local exception remains.**
Focused F-06 non-regression: builder 27, filters 6, server 12, nav 7, Citation Structure stories 11, sidebar stories 13 — all pass; no application file changed (`git diff --name-status 9bc5ba89..39276776` = 6 operational/test files).
CI: PR #23 required checks Build / E2E Integration Tests / Scheduling Policy Verification / smoke / Dependency License Audit success; post-merge `main` workflows at `39276776` success.

Windows rehearsal (disposable `mkdtemp` dir, synthetic fixture, removed afterwards): first run wrote `.env` (17 keys) + `elmo.yaml`; fixture `.env` sha256 `c2641463…e204` unchanged across repins `g48e69783` → `g4f30f53e` → `g48e69783`; `docker compose config --quiet` valid with images `elmo-{db-migrate,web,worker}:g48e69783` + `postgres:18-alpine`; the `g4f30f53e` diff was the header timestamp plus exactly the three image lines. Live `~/.elmo/.env`/`elmo.yaml` hashes unchanged throughout the whole corrective (`5155578153d44336` / `1690d903f0f175c3`).

Read-only production acceptance after the merge (13:22Z): running trio and digests as above, HTTP 200, journal 20, citations 931 / enabled prompts 33 / runs 318 (one scheduled run since the F-06 cutover); Citations and Citation Structure load through the sidebar (81 owned occurrences = root = every depth, 27 nodes), 0 console/page errors, 0 failed same-origin requests; worker log 0 errors; web log only the `Error: aborted / ECONNRESET` pairs stamped at the acceptance browser's own navigations; config hashes identical before and after.

## Production-write wording (replaces the original closeout's "no data written")

- new F-06 business/analytics write paths: **0**
- citation / prompt / run / brand / classification / tag writes during the F-06 acceptance and this corrective: **0**
- normal authentication side effect: exactly **one `session` row created and deleted** per headless acceptance run (F-06 acceptance 11:12Z; Corrective R1 CP0 12:49Z and CP8 13:22Z), session count restored to 1 each time. The acceptance runs are therefore read-only with respect to business data, not literally write-free.
- no Docker rebuild, retag, container recreation or restart; no live production configuration rewritten.

## Residual risks

- `pnpm test:scripts` (root `package.json`: `node --test 'scripts/*.test.mjs'`) runs 0 tests on Windows because the single-quoted glob is passed literally by the Windows shell; Linux CI expands it and runs all 30. Changing the package manifest was outside this corrective's scope. Owner: operator; follow-up: switch to double quotes in a separate small PR.
- Production still only has `www.*` owned hosts; apex/subdomain separation remains proven by fixtures (unchanged from F-06).
- The rollback trio `g4f30f53e` predates the Citation Structure route; rolling back removes the page (by design) — unchanged.

## F-07 predecessor baseline

```
F07_PLANNING_BASELINE_SHA=33c94cd175f9b128cfd03901ff04ab51fc189f45
F07_START_MAIN_SHA=<the squash SHA of the PR carrying this file — see docs/phase1/production-manifest.md and the release production/f06-owned-citation-structure-closeout-r1-2026-09-06>
F07_START_PROD_APP_SOURCE_SHA=48e697837045c585ffaf32d821dcf601f841ab5d
F07_START_PROD_WEB_IMAGE=elmo-web:g48e69783@sha256:6891e26bc69f44b24978e552e22365384613a96f1d0b61ae55d10275deca766c
F07_START_PROD_WORKER_IMAGE=elmo-worker:g48e69783@sha256:8842d34fe941fb18c0bbf5168d80f77b3635f922eed77390fa3227e02e6c0459
F07_START_PROD_DB_MIGRATE_IMAGE=elmo-db-migrate:g48e69783@sha256:167d86d1c39beb54fa50fe7a7a625a6ee7a2c6235e70b9c091a0a46264c1a07f
F07_ROLLBACK_WEB_IMAGE=elmo-web:g4f30f53e@sha256:2ae5f5cb013f71db44f150e0465a8a7dc9e749ff51af20285ffbbc8733fe9158
F07_ROLLBACK_WORKER_IMAGE=elmo-worker:g4f30f53e@sha256:01191f72864d34e10c2dcdd4438f0bd7fa8d17f447f97641271a0b10600c127d
F07_ROLLBACK_DB_MIGRATE_IMAGE=elmo-db-migrate:g4f30f53e@sha256:244e60d21d24aaad7f1501692bc6e136dc21cfa51f86e0415360540a10b0122a
F07_START_MIGRATION_JOURNAL_COUNT=20
```

Commits after the application source: `9bc5ba89` docs-only (#22) · `39276776` operations/test-only (#23) · this closeout, docs-only. None is an image source; F-07 CP0 must re-verify every value independently.
