# BRAND-LOGO-01 — `aitrckr` wordmark: inventory, scope and pre-merge acceptance

Status: **corrected CP3 candidate** (2026-09-14, R2). R1 covered the product UI (`apps/web`); the R2 correction extends the same rule — every rendered wordmark, wherever it lives — to the marketing site (`apps/www`) and the shared social-image renderer (`packages/og`). Production closeout is a separate document written after `DEPLOY GO`.
Raw evidence (RED/GREEN logs, full screenshot set, measurement JSON, E2E logs): operator-private `~/.elmo/brand-logo-01-evidence/`.

## Identities

| Item | Value |
|---|---|
| Baseline (`origin/main` at branch point) | `486e8e2c20599fb08dbb4bc023c8f31c855d5c4e` (SENT-01 grounded evidence, PR #44) |
| Branch / worktree | `feature/brand-logo-01-aitrckr`, isolated worktree `aitrckr-brand-logo-01` |
| Production at CP0 | web `127.0.0.1:1515`, wordmark `elmo` measured 79 px wide at `text-3xl` Titan One (`00-before-login-desktop.png`) |
| Isolated verification stack (R1, `apps/web`) | compose project `elmo-brand-logo-01-test`, web `127.0.0.1:1523`, postgres `127.0.0.1:5442`, images built from this branch; no shared or production container touched. **Retired after R1 evidence was captured**: resources enumerated by the `com.docker.compose.project=elmo-brand-logo-01-test` label (3 containers, 1 volume, 1 network — none shared), then `docker compose down -v` under that project name only; 0 labelled resources remain, every other project untouched |
| Marketing-site verification (R2, `apps/www`) | `vite dev --port 3101` from this worktree (no Upstash credentials, so `/og/status.png` is 500 in that environment and the status image was rasterised offline with empty data); stopped afterwards |

## What changed

The word `elmo` rendered as the visual wordmark (Titan One, lowercase, brand blue) now reads `aitrckr` — in the product UI, on the marketing site and in the generated social images. Font, size, weight, colour, container, link target and whitelabel behaviour are unchanged.

**Wordmark implementations: 4 shared/inline components plus 3 single-site inline marks** — `apps/web/src/components/logo.tsx` (shared `Logo`), `apps/web/src/components/chart-export-preview.tsx`, `apps/www/src/components/logo.tsx` (shared www `Logo`), `packages/og/src/render.ts` (social image); single-site: `apps/www/src/routes/brand.tsx` specimen, `apps/www/src/lib/status-og.tsx`, `apps/www/scripts/generate-demo-posters.tsx`. **Rendered surfaces: 13** — web: sidebar (desktop + mobile sheet), auth pages, `FullPageCard`, report cover/footers, chart export PNG, `/api/og`; www: navbar (every page layout incl. docs), footer, brand-page typography specimen, `/og.png` + `/og/docs/*`, `/og/status.png`, YouTube variant of the demo poster generator. Nothing else that says `elmo`/`Elmo` — package names, imports, env vars, DB, Docker images, docs, domains, the app name in `<title>`/manifest, prose — is renamed.

## Logo inventory

`rg -n "font-titan-one"` and `rg -n -i "elmo"` over `apps/`, `packages/`, `e2e/` (excluding `node_modules`, `.output`, `dist`, lockfile).

| File | UI location | Logo occurrence? | Action |
|---|---|---|---|
| `apps/web/src/components/logo.tsx` | shared `Logo` — the product UI wordmark | Yes | Replaced |
| `apps/web/src/components/app-sidebar.tsx` | desktop sidebar header + mobile sheet header (`Logo` → link `/app`; static on the account gate page) | Yes (via `Logo`) | No change needed |
| `apps/web/src/components/auth/auth-split-layout.tsx` | sign-in / sign-up / password pages | Yes (via `Logo`) | No change needed |
| `apps/web/src/components/full-page-card.tsx` | `/`, `/app` directory, new brand, onboarding, not-found, missing-env, accept-invitation | Yes (via `Logo`, link `/app` when signed in) | No change needed |
| `apps/web/src/routes/_authed/reports/render/$reportId.tsx` | printable report cover + every page footer | Yes (via `Logo`, muted `textClassName`) | No change needed |
| `apps/web/src/components/chart-export-preview.tsx:110` | footer of the exported chart PNG (`html2canvas`) | Yes (separate inline wordmark) | Replaced |
| `apps/web/src/stories/brand-kit.stories.tsx` | Storybook brand kit (renders `Logo`; header comment named the wordmark) | Yes (comment) | Comment updated |
| `apps/web/src/stories/{logo,app-sidebar,login,chart-export-preview}.stories.tsx` | Storybook play tests | Test | Added / updated to assert `aitrckr` |
| `e2e/tests/local/local-deployment.spec.ts`, `e2e/tests/whitelabel/whitelabel-deployment.spec.ts` | E2E branding contract | Test | Updated to assert `aitrckr` present (local) / absent (whitelabel) |
| `apps/www/src/components/logo.tsx` | shared www `Logo`: navbar (every page layout, including docs via `docs-page-layout.tsx`) and footer, both inside `Link to="/" aria-label="Homepage"` | Yes | Replaced (R2) |
| `apps/www/src/components/navbar.tsx`, `apps/www/src/components/footer.tsx` | render the www `Logo` (`text-2xl` / `text-3xl`) | Yes (via `Logo`) | No change needed |
| `apps/www/src/routes/brand.tsx:250` | brand-assets page, Titan One typography specimen | Yes (inline) | Replaced (R2) |
| `packages/og/src/render.ts` | social-image renderer shared by www `/og.png`, `/og/docs/*` and web `/api/og` (stock-branding branch) | Yes (inline, Titan One 140 px) | Replaced (R2) |
| `apps/www/src/lib/status-og.tsx:96` | `/og/status.png` provider-status social image | Yes (inline, Titan One 46 px) | Replaced (R2) |
| `apps/www/scripts/generate-demo-posters.tsx:225` | YouTube-thumbnail variant of the demo-poster generator (written outside the repo); the committed `public/demo-poster.png` carries only the **e** glyph and is unchanged | Yes (inline) | Replaced (R2); no asset regeneration needed |
| `apps/www/src/lib/og.ts:11`, `apps/www/src/lib/repo-activity/fonts.ts:2` | comments naming the wordmark | Comment | Updated (R2) |
| `packages/og/src/render.ts` watermark `"e"`, `apps/www/scripts/generate-brand-icons.tsx`, `apps/www/public/icons/*`, `apps/www/src/lib/repo-activity/svg/*` (Titan One KPI numerals) | the **e** glyph / display face, not the word | No | Kept |
| `apps/www` prose: `competitor-comparison.tsx`, `multi-comparison.tsx`, `pair-comparison.tsx`, `open-source.tsx` ("Elmo" table headers), `feature-graphics.tsx` alt text, `authors.ts`, `seo.ts` `SITE_NAME`, `navbar.tsx:97` `aria-label="Star elmo on GitHub"` (names the GitHub repo, not the mark), footer link "Elmo Cloud Status" | ordinary text / SEO name / repo reference | No | Kept |
| `e2e/tests/www/branding.spec.ts` (new `www` Playwright project), `apps/web/src/routes/api/og/__tests__/og-image.test.ts` | www branding contract; shared OG renderer contract | Test | Added (R2) |
| `apps/web/public/icons/elmo-icon*.{svg,png}`, `favicon.ico`, `apple-touch-icon.png` | favicon / PWA icon: the letter **e** in Titan One, not the word | No (glyph, not wordmark) | Kept |
| `apps/web/src/routes/__root.tsx:72`, `apps/web/src/lib/route-head.ts:14`, `apps/web/src/routes/api/manifest`, `packages/config/src/constants.ts:12` (`DEFAULT_APP_NAME = "Elmo"`) | document title, manifest `short_name`, default branding name | No (app name, also the whitelabel switch) | Kept |
| `apps/web/src/routes/auth/login.tsx:216` "Sign in to your Elmo instance.", `$reportId.tsx:893/927` "Get started with Elmo", `crisp.ts`, `sales-panel.tsx` | prose | No | Kept |
| `$reportId.tsx:1065` `branding?.url \|\| "elmo.chat"`, `customers.tsx` `?ref=elmo`, `github.com/elmohq/elmo` | domains / URLs | No | Kept |
| `packages/config`, `packages/lib`, `apps/cli`, `apps/worker`, `docker/`, `.changeset/*`, `docs/**` | package names, CLI, env registry, images, docs, historical closeouts | No | Kept |

## Requirements → tests → evidence

| Requirement | Test | Evidence | Status |
|---|---|---|---|
| BRAND-LOGO-F-001 completeness — every wordmark shows `aitrckr` | **web:** Storybook `Brand / Logo › Wordmark`; `App Sidebar › Local`; `Auth / Sign in › Self Hosted`; `Chart Export Preview › Elmo Default` (3 marks); E2E `stock branding is used`. **www + social images:** Playwright project `www` (`e2e/tests/www/branding.spec.ts`: navbar, footer, docs layout × desktop/mobile, brand specimen, `/og.png`); unit `og-image.test.ts` (stock image signed `aitrckr`, whitelabel image has no wordmark) | web: RED on `486e8e2c` (4 failed / 18 passed) → GREEN (24/24); E2E local project 118 passed; visual driver 43 readings. www: RED on `b16a9465` (5 failed, "Received: elmo"; unit `expected [ 'e', 'elmo' ] to include 'aitrckr'`) → GREEN on `94a278d0` (8/8 www, 2/2 unit); www visual driver 10 readings all `aitrckr` | PASS |
| BRAND-LOGO-F-002 scope precision — no non-logo `elmo` changed | `git diff 486e8e2c..HEAD --stat`: web `logo.tsx`, `chart-export-preview.tsx`; www `logo.tsx`, `brand.tsx`, `status-og.tsx`, `generate-demo-posters.tsx`; `packages/og/src/render.ts`; two www comments; stories, E2E specs, unit test, Playwright config, changeset, this evidence | inventory above; residual `elmo` occurrences enumerated with reasons; prose, `SITE_NAME`, repo `aria-label`, icons, package/env/docker identifiers untouched | PASS |
| BRAND-LOGO-F-003 layout — fits, one line, no clip/ellipsis/overlap/horizontal scroll at 1440×900 and 390×844 | `e2e/brand-logo-01-visual.local.mts` and `e2e/brand-logo-01-www-visual.local.mts` (git-excluded drivers): bounding box vs every overflow-clipping ancestor and the viewport, line height, sibling intersection, `scrollWidth` vs `innerWidth`; `branding.spec.ts` asserts `scrollWidth ≤ clientWidth`, single line, no document overflow | web: 116×36 px on every 3xl surface (sidebar 16 rem rail; mobile sheet 18 rem); report cover 54×20, footers 39×15. www: navbar 64×32 → **93×32** (`text-2xl`), footer 79×34 → **116×34** (`text-3xl`), brand specimen block 490/308 px wide, all at the same positions as before; no failures; screenshots `01`–`07`, `10`–`17` | PASS |
| BRAND-LOGO-F-004 navigation — link target unchanged | web: E2E `stock branding is used` (`a[data-sidebar=menu-button]` href `/app`), `App routing › the mark on a full-page view leads to the directory`. www: `branding.spec.ts` navbar + footer `getByRole("link", { name: "Homepage" })` href `/` | web: sidebar / full-page-card / not-found href `/app`; auth pages and report unlinked as before. www: navbar and footer marks href `/`, `aria-label="Homepage"` unchanged; brand specimen still links to the Google Fonts specimen | PASS |
| BRAND-LOGO-F-005 accessibility — accessible name `aitrckr`, old name gone | Storybook `App Sidebar › Local` (`role=button name="aitrckr"`), `Brand / Logo › Wordmark` (no `/elmo/i` inside the logo, no `img`); www `branding.spec.ts` `not.toContainText("elmo")` inside each mark | web mark has no `aria-label`; its name is its text; whitelabel `img alt="{name} logo"` unchanged. www marks sit inside pre-existing brand-neutral `aria-label="Homepage"` links; no `alt`/`title` names the old wordmark | PASS |
| BRAND-LOGO-F-006 regression safety — no API/worker/DB/scheduler/provider/data change | diff touches only `apps/web/src/{components,stories,routes/api/og/__tests__}`, `apps/www/{src,scripts}` presentation files, `packages/og/src/render.ts` (one string), `e2e`, `.changeset`, `docs` | R2: `pnpm lint` clean; `pnpm test` 14/14 tasks (web 530, lib 883, config 94, cloud 43, cli 28); `pnpm build` 16/16 (includes `apps/www`); lockfile unchanged; no new dependency | PASS |

## Responsive matrix — `apps/web` (isolated stack, `EXPECT=aitrckr`)

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

## Responsive matrix — `apps/www` (dev server on :3101, `EXPECT=aitrckr`)

| Surface | 1440×900 | 390×844 |
|---|---|---|
| Navbar on `/` (`text-2xl`, link `/`) | PASS — 93×32 px | PASS — 93×32 px beside the menu trigger and "Sign up" |
| Navbar on `/docs` (docs page layout) | PASS | PASS |
| Footer on `/` (`text-3xl`, link `/`) | PASS — 116×34 px | PASS — 116×34 px |
| `/brand` typography specimen | PASS | PASS |
| `/og.png`, `/og/docs/getting-started` | PASS — 200 `image/png`, wordmark `aitrckr` (`16-og-image.png`) | — |
| `/og/status.png` | rasterised offline with empty data (`17-og-status-image.png`); the live route needs Upstash credentials | — |

Baseline observations, not branding defects: opening the www mobile menu ("Open menu" popover) trips a Base UI "CompositeRootContext is missing" error boundary on `486e8e2c` as well — recorded (`www-screenshots/*navbar-mobile-menu-open.png`), not fixed here; `/og/status.png` returns 500 without Upstash credentials.

The www Playwright project is opt-in (`pnpm -C e2e exec playwright test --project=www` against a running `apps/www`; `WWW_BASE_URL` defaults to `http://localhost:3001`); CI does not start the marketing site.

## Rollback

Revert the squash commit of this PR (or redeploy the previous immutable image trio). No migration, data or configuration change is involved.
