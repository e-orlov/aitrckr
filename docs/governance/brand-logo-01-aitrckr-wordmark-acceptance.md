# BRAND-LOGO-01 — `aitrckr` wordmark: inventory, scope and pre-merge acceptance

Status: **CP3 candidate** (2026-09-14). Production closeout is a separate document written after `DEPLOY GO`.
Raw evidence (RED/GREEN logs, full screenshot set, measurement JSON, E2E logs): operator-private `~/.elmo/brand-logo-01-evidence/`.

## Identities

| Item | Value |
|---|---|
| Baseline (`origin/main` at branch point) | `486e8e2c20599fb08dbb4bc023c8f31c855d5c4e` (SENT-01 grounded evidence, PR #44) |
| Branch / worktree | `feature/brand-logo-01-aitrckr`, isolated worktree `aitrckr-brand-logo-01` |
| Production at CP0 | web `127.0.0.1:1515`, wordmark `elmo` measured 79 px wide at `text-3xl` Titan One (`00-before-login-desktop.png`) |
| Isolated verification stack | compose project `elmo-brand-logo-01-test`, web `127.0.0.1:1523`, postgres `127.0.0.1:5442`, images built from this branch; no shared or production container touched |

## What changed

The word `elmo` rendered as the visual wordmark (Titan One, lowercase, `text-blue-600`) now reads `aitrckr`. Font, size, weight, colour, container, link target and whitelabel behaviour are unchanged. Nothing else that says `elmo`/`Elmo` — package names, imports, env vars, DB, Docker images, docs, domains, the app name in `<title>`/manifest, prose — is renamed.

## Logo inventory

`rg -n "font-titan-one"` and `rg -n -i "elmo"` over `apps/`, `packages/`, `e2e/` (excluding `node_modules`, `.output`, `dist`, lockfile).

| File | UI location | Logo occurrence? | Action |
|---|---|---|---|
| `apps/web/src/components/logo.tsx` | shared `Logo` — the only wordmark implementation in the product | Yes | Replaced |
| `apps/web/src/components/app-sidebar.tsx` | desktop sidebar header + mobile sheet header (`Logo` → link `/app`; static on the account gate page) | Yes (via `Logo`) | No change needed |
| `apps/web/src/components/auth/auth-split-layout.tsx` | sign-in / sign-up / password pages | Yes (via `Logo`) | No change needed |
| `apps/web/src/components/full-page-card.tsx` | `/`, `/app` directory, new brand, onboarding, not-found, missing-env, accept-invitation | Yes (via `Logo`, link `/app` when signed in) | No change needed |
| `apps/web/src/routes/_authed/reports/render/$reportId.tsx` | printable report cover + every page footer | Yes (via `Logo`, muted `textClassName`) | No change needed |
| `apps/web/src/components/chart-export-preview.tsx:110` | footer of the exported chart PNG (`html2canvas`) | Yes (separate inline wordmark) | Replaced |
| `apps/web/src/stories/brand-kit.stories.tsx` | Storybook brand kit (renders `Logo`; header comment named the wordmark) | Yes (comment) | Comment updated |
| `apps/web/src/stories/{logo,app-sidebar,login,chart-export-preview}.stories.tsx` | Storybook play tests | Test | Added / updated to assert `aitrckr` |
| `e2e/tests/local/local-deployment.spec.ts`, `e2e/tests/whitelabel/whitelabel-deployment.spec.ts` | E2E branding contract | Test | Updated to assert `aitrckr` present (local) / absent (whitelabel) |
| `apps/www/src/components/logo.tsx`, `apps/www/src/routes/brand.tsx:250`, `apps/www/src/lib/og.ts`, `apps/www/src/lib/repo-activity/fonts.ts` | upstream marketing site (`apps/www`, port 3001) — not part of this fork's product deployment (web + worker + db-migrate only) | Yes, but outside the product UI | **Kept** — flagged for a separate decision |
| `apps/web/public/icons/elmo-icon*.{svg,png}`, `favicon.ico`, `apple-touch-icon.png` | favicon / PWA icon: the letter **e** in Titan One, not the word | No (glyph, not wordmark) | Kept |
| `apps/web/src/routes/__root.tsx:72`, `apps/web/src/lib/route-head.ts:14`, `apps/web/src/routes/api/manifest`, `packages/config/src/constants.ts:12` (`DEFAULT_APP_NAME = "Elmo"`) | document title, manifest `short_name`, default branding name | No (app name, also the whitelabel switch) | Kept |
| `apps/web/src/routes/auth/login.tsx:216` "Sign in to your Elmo instance.", `$reportId.tsx:893/927` "Get started with Elmo", `crisp.ts`, `sales-panel.tsx` | prose | No | Kept |
| `$reportId.tsx:1065` `branding?.url \|\| "elmo.chat"`, `customers.tsx` `?ref=elmo`, `github.com/elmohq/elmo` | domains / URLs | No | Kept |
| `packages/config`, `packages/lib`, `apps/cli`, `apps/worker`, `docker/`, `.changeset/*`, `docs/**` | package names, CLI, env registry, images, docs, historical closeouts | No | Kept |

## Requirements → tests → evidence

| Requirement | Test | Evidence | Status |
|---|---|---|---|
| BRAND-LOGO-F-001 completeness — every wordmark shows `aitrckr` | Storybook `Brand / Logo › Wordmark`; `App Sidebar › Local`; `Auth / Sign in › Self Hosted`; `Chart Export Preview › Elmo Default` (3 marks); E2E `stock branding is used` | RED on `486e8e2c` (4 failed / 18 passed) → GREEN on `a0994d71` (24/24); E2E local project 118 passed on the isolated stack; visual driver 43 readings all `aitrckr` | PASS |
| BRAND-LOGO-F-002 scope precision — no non-logo `elmo` changed | `git diff 486e8e2c..HEAD --stat`: `logo.tsx`, `chart-export-preview.tsx`, one story comment, 4 stories, 2 E2E specs, changeset, this evidence | inventory above; residual `elmo` occurrences enumerated with reasons | PASS |
| BRAND-LOGO-F-003 layout — fits, one line, no clip/ellipsis/overlap/horizontal scroll at 1440×900 and 390×844 | `e2e/brand-logo-01-visual.local.mts` (git-excluded driver): bounding box vs every overflow-clipping ancestor and the viewport, line height, sibling intersection, `scrollWidth` vs `innerWidth` | 116×36 px on every 3xl surface (sidebar 16 rem rail → 116 px of 208 px content width; mobile sheet 18 rem); report cover 54×20, footers 39×15; no failures; screenshots `01`–`07` | PASS |
| BRAND-LOGO-F-004 navigation — link target unchanged | E2E `stock branding is used` (`a[data-sidebar=menu-button]` href `/app`), `App routing › the mark on a full-page view leads to the directory`; visual driver href column | sidebar / full-page-card / not-found href `/app`; auth pages and report unlinked as before | PASS |
| BRAND-LOGO-F-005 accessibility — accessible name `aitrckr`, old name gone | Storybook `App Sidebar › Local` (`role=button name="aitrckr"`), `Brand / Logo › Wordmark` (no `/elmo/i` inside the logo, no `img`) | the mark has no `aria-label`; its name is its text; whitelabel `img alt="{name} logo"` unchanged | PASS |
| BRAND-LOGO-F-006 regression safety — no API/worker/DB/scheduler/provider/data change | diff touches only `apps/web/src/{components,stories}`, `e2e/tests`, `.changeset`, `docs` | `pnpm lint` clean; `pnpm test` 14/14 tasks (web 528, lib 883, config 94, cloud 43, cli 28); `pnpm build` 16/16; lockfile unchanged | PASS |

## Responsive matrix (isolated stack, `EXPECT=aitrckr`)

| Surface | 1440×900 light | 1440×900 dark¹ | 390×844 light | 390×844 dark¹ |
|---|---|---|---|---|
| `/auth/login` (AuthSplitLayout) | PASS | PASS | PASS | PASS |
| Sidebar expanded (`/app/org/default/brand/default`) | PASS | PASS | PASS (sheet) | PASS (sheet) |
| Sidebar collapsed (offcanvas) | PASS — rail hidden, no mark visible, no overflow | PASS | n/a (sheet closed) | n/a |
| FullPageCard (`/app/org/not-a-organization`) | PASS | PASS | PASS | PASS |
| Not-found (`/appadsf`) | PASS | PASS | PASS | PASS |
| Report render (cover + 5 footers) | PASS | PASS | PASS | PASS |
| Chart export PNG (offscreen preview + downloaded file) | PASS | — | — | — |

¹ The product has no theme switch; `prefers-color-scheme: dark` emulation produces byte-identical screenshots. Recorded to show the layout is scheme-independent.

## Rollback

Revert the squash commit of this PR (or redeploy the previous immutable image trio). No migration, data or configuration change is involved.
