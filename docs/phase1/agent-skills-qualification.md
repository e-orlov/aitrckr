# Agent Skills — lock and qualification record (Phase 1)

## Source lock

| Field | Value |
|---|---|
| Upstream URL | https://github.com/addyosmani/agent-skills |
| Exact commit SHA (audited) | `d2c37ef6225dd8726cdd369a8030307f48592d26` |
| Commit date | 2026-08-28 16:30:57 -0700 ("chore(release): bump plugin manifests to 0.6.8") |
| Retrieval UTC | 2026-08-29T09:08:39Z |
| License | MIT (Copyright (c) 2025 Addy Osmani) |
| Retrieval method | `git clone` (HTTPS, read-only) into `<workspace>\_audit-tmp\agent-skills-audit-readonly` — explicitly marked audit folder, nothing activated or executed |
| Skills in source | 25 |
| Install method policy | copy approved directories only into `.claude/skills/<name>/`; no `npx skills add`, no marketplace, no plugin.json/commands/agents/hooks/meta-skill, no global install, no auto-update |
| Update procedure | manual only: re-clone, diff against locked SHA, re-run full qualification suite, update this record |

Relevant open upstream issues checked 2026-08-29 (via GitHub issues page): no open issue about Claude Code portability, broken inter-skill references, or shared-references breakage for the candidate set. Closest: #475 (Windows bash/jq SessionStart hook fails — concerns repo's `hooks/`, which we do not install), #494 (Cursor-specific), #511 (documentation-and-adrs doc-drift gap — noted, does not affect our usage).

## Static audit of candidate set (commit d2c37ef)

All 10 candidates are single self-contained `SKILL.md` files. Scan results (CT-SKILL-002 pre-check):

- frontmatter contains only `name` + `description` — no `allowed-tools`, no `disable-model-invocation`, no `context`;
- no dynamic `` !` `` shell injections, no `@` file references, no `../` cross-directory links;
- no scripts, hooks, subagents, network actions, or destructive commands;
- sizes: 203–499 lines each (3142 total).

## Inventory of already-available Claude Code skills (this session, Claude Desktop)

- Bundled/plugin (anthropic-skills and built-ins): `consolidate-memory`, `docx`, `explain-usage`, `frontend-design`, `pdf`, `pdf-reading`, `pptx`, `schedule`, `setup-cowork`, `xlsx`, `dataviz`, `update-config`, `keybindings-help`, `simplify`, `fewer-permission-prompts`, `loop`, `claude-api`, `run`, `init`, `security-review`.
- Bundled `/debug`, `/code-review`, `/verify`: **not present** in this session's skill list (the bundled `simplify` description references `/code-review`, but it is not exposed here). To be re-checked after session reload (IT-SKILL-001).
- Project skills shipped by the fork repo: `add-changeset`, `add-competitor` (in `.claude/skills/`). Not discovered by the current session because `.claude/skills/` did not exist at session start (folder contained only the master prompt). Session reload checkpoint applies (master prompt §4 checkpoint 10, §7.C.10).
- Personal/global skills: none observed beyond the plugin set above.

## Compatibility / selection table (candidate set, master prompt §3.5)

| Skill | Unique value beyond master prompt / repo instructions / bundled | Overlap | References/executable behavior | Permissions/context risk | Proposed invocation policy | Verdict |
|---|---|---|---|---|---|---|
| `source-driven-development` | Repeatable cite-official-sources procedure for version-dependent decisions (Docker Desktop headless start, WSL systemd, OpenRouter web-search API, pnpm/pg-boss) — directly supports MP §11 verification-first rule | Partial with MP §11 (list of sources), but MP gives no procedure | none / none | Low; ~216 lines context | Auto for external version-dependent decisions (Docker/WSL/OpenRouter/framework APIs) | **SELECT** |
| `debugging-and-error-recovery` | Structured triage for unexpected failures; no bundled `/debug` available in this environment | AGENTS.md has no debugging guidance | none / none | Low; ~300 lines | Only on actual unexpected failure (test/build/runtime), never proactively | **SELECT** |
| `code-review-and-quality` | Multi-axis pre-PR review; bundled `/code-review` not visible in this session | Possible duplicate if bundled `/code-review` appears after reload | none / none | Low; ~396 lines | User- or self-invoked once before commit/PR of code changes | **SELECT (conditional)** — becomes `REJECTED AS DUPLICATE` if bundled `/code-review` is discovered after reload and passes a smoke test |
| `context-engineering` | None: master prompt + AGENTS.md/CLAUDE.md already define context discipline; MP forbids CLAUDE.md sprawl anyway | High (MP §3.5/§6, AGENTS.md comments/docs rules) | none / none | Low | — | **REJECT** (duplicate of MP + repo instructions) |
| `security-and-hardening` | None beyond bundled `security-review` skill + MP §5.3/§5.4 explicit secret/network rules; generic public-web checklist partly inapplicable to loopback deployment | High (bundled `security-review`, MP §5) | none / none | Low | — | **REJECT AS DUPLICATE** |
| `test-driven-development` | MP V-model + AGENTS.md test rules already govern; behavior-changing fixes are minimal in Phase 1 | High | none / none | Low | — | **DEFER** — return only if a Phase 1 compatibility fix changes behavior and characterization/TDD guidance is actually needed |
| `documentation-and-adrs` | MP §8 already mandates decision records (gate record, runbook, manifest) | High | none / none | Low | — | **DEFER** — return only for a significant architecture decision (e.g. Docker Engine fallback) |
| `observability-and-instrumentation` | MP §7.K already prescribes exact logging/health/watchdog requirements | Medium-high | none / none | Low | — | **DEFER** — return at stage K only if MP requirements prove insufficient |
| `shipping-and-launch` | MP GATE-R4/R5 exit criteria are stricter and specific; DNS/CDN/public TLS sections inapplicable by design | High | none / none | Low | — | **DEFER** — optional checklist cross-read at GATE-R4/R5; not installed unless a gap is found |
| `doubt-driven-development` | Fresh-context adversarial check; extra model calls/cost; MP forbids automatic use | Medium (MP gates already force evidence) | none / none | Medium (cost) | — | **DEFER** — only on proven benefit, after explicit user cost warning |

Excluded-by-default list (MP §3.5) remains excluded: `using-agent-skills`, `interview-me`, `idea-refine`, `spec-driven-development`, `constraint-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, `git-workflow-and-versioning`, `browser-testing-with-devtools`, `frontend-ui-engineering`, `api-and-interface-design`, `ci-cd-and-automation`, `performance-optimization`, `code-simplification`, `deprecation-and-migration`. No uncovered requirement found that would justify returning any of them.

## Precedence order (binding for any installed skill)

1. Master prompt decisions/constraints → 2. fork `AGENTS.md`/`CLAUDE.md`/security rules → 3. verified code/tests/runtime of current commit → 4. current official external docs → 5. project-scoped third-party skill → 6. generic skill advice. Conflicts are recorded, never silently resolved. Skills cannot expand scope, cancel checkpoints/V-gates, change Git policy, add providers/MCP, or waive test evidence.

## Qualification test plan (executed at stage C, GATE-S1)

| Test ID | Check | Expected result |
|---|---|---|
| CT-SKILL-001 | frontmatter/name/directory/reference validity of copied skills | valid YAML, names match dirs, zero external references |
| CT-SKILL-002 | static audit: no unjustified scripts/hooks/shell injections/network/permissions | zero findings (pre-check on d2c37ef already clean) |
| IT-SKILL-001 | discovery + invocation in project scope after session reload | each installed skill and repo skills `add-changeset`/`add-competitor` discoverable and invocable |
| ST-SKILL-001 | synthetic behavior scenarios (documented framework decision; artificial failing test) without touching production/repo state | skill produces claimed behavior; no repo mutation |
| ST-SKILL-002 | precedence/conflict test: generic skill advice vs master prompt/repo rule | master prompt/repo rule wins; conflict logged |
| ST-SKILL-003 | non-trigger test: unrelated prompt does not invoke costly/scope-expanding skill | no unintended invocation |

## Lock record for installed skills (stage C, 2026-08-29)

Source re-verified immediately before copy: `git rev-parse HEAD` in audit clone = `d2c37ef6225dd8726cdd369a8030307f48592d26`, working tree clean. Bundled `/code-review` confirmed absent in this Claude Desktop environment → conditional SELECT for `code-review-and-quality` resolved to **SELECT**. MIT license copy: [agent-skills-LICENSE.txt](agent-skills-LICENSE.txt).

| Copied file (project scope) | Upstream SHA-256 | Local SHA-256 | Local modification |
|---|---|---|---|
| `.claude/skills/source-driven-development/SKILL.md` | `719d4e54083c90ded62112fb41df3dbc4619309118ee0e6aa4d846f92d8204af` | identical | none |
| `.claude/skills/debugging-and-error-recovery/SKILL.md` | `67ce2c9442da0c5a6e3515617fc9c4003cfe232ef7c7210da342f40f508f9958` | identical | none |
| `.claude/skills/code-review-and-quality/SKILL.md` | `8f3cabca581bbf7cb5f0add3f7454e7a4523f9d4353a6a4a217e6fa515309612` | `bec431b759ff389e47b8d2c9d74e1981ff93cf5f3c36b4a3b6a71a75c250be2c` | PATCH-1: "See Also" links rewritten from `../../references/…` to `references/…` (self-contained layout per MP §7.C.5) |
| `.claude/skills/code-review-and-quality/references/security-checklist.md` | `a8bbff3b1ac9122985e98fbe9a8fa09cd8ad53b190bac7f8f0f63687900f7d7a` | identical | copied from shared upstream `references/` into skill dir |
| `.claude/skills/code-review-and-quality/references/performance-checklist.md` | `40f564d1e62341e277c01ba42c42d95264b9ef3b8e5a23249dc6e121a7e70067` | identical | copied from shared upstream `references/` into skill dir |

Accepted non-blocking notes (no patch): prose mentions of non-installed skills (`security-and-hardening`, `test-driven-development`, `performance-optimization`) inside installed SKILL.md texts are informational, not file references; the referenced guidance is covered by the bundled `security-review` skill, repo AGENTS.md test rules, and the reference checklists respectively. `npx …` example commands inside reference checklists conflict with the repo's pnpm-only rule — precedence order applies (repo instruction wins); used as ST-SKILL-002 test case.

### Invocation policy (binding)

- `source-driven-development`: may auto-apply for version-dependent external decisions (Docker Desktop/Engine, WSL, OpenRouter API, pnpm/pg-boss/framework APIs). No network actions beyond fetching official docs already permitted by the master prompt.
- `debugging-and-error-recovery`: only on an actual unexpected failure; never proactively.
- `code-review-and-quality`: invoked once per meaningful code diff before commit/PR; advisory only — cannot replace V-model tests/evidence or repository lint/test gates.
- None of the installed skills may expand scope, cancel user checkpoints or V-gates, alter Git policy, add providers/MCP, or run paid/model-spawning workflows. `doubt-driven-development` remains DEFERRED and is not installed.

### Qualification status

- CT-SKILL-001 — **PASS** (2026-08-29): valid frontmatter/names/dirs for all 5 project skills; zero `../../` references remain; all supporting references resolve inside skill dirs.
- CT-SKILL-002 — **PASS** (2026-08-29): static audit of copied files — no scripts, hooks, dynamic `` !` `` injections, `@` references, subagents, network actions, destructive commands, or tool-permission grants.
- IT-SKILL-001 — **PASS** (2026-08-29, new session after reload): all 5 project skills (`add-changeset`, `add-competitor`, `source-driven-development`, `debugging-and-error-recovery`, `code-review-and-quality`) present in the session's available-skills list; each of the 3 installed skills actually invoked via the Skill tool and loaded its full SKILL.md into project scope. Bundled `/code-review` re-checked after reload: still **absent** → conditional SELECT for `code-review-and-quality` stands as SELECT.
- ST-SKILL-001 — **PASS** (2026-08-29): three synthetic scenarios, zero repo/production mutation.
  - `source-driven-development`: synthetic version-dependent question (Docker Desktop pre-logon start). Skill procedure followed: fetched official https://docs.docker.com/desktop/settings-and-maintenance/settings/ — only autostart option is "Start Docker Desktop when you sign in to your computer" (default Disabled); no pre-logon/boot setting documented. Cited finding matches MP §3.1 premise.
  - `debugging-and-error-recovery`: artificial failing log (`expected 42, received NaN`, `mentions.length undefined`). Skill triage produced reproduce→localize→reduce→root-cause (caller passes undefined instead of array; not a NaN-guard symptom fix)→regression-guard analysis. No commands run, no edits.
  - `code-review-and-quality`: fixture diff (not in repo) reviewed across the five axes; correctly flagged Critical SQL injection (string-concatenated query), Critical secret logging (`OPENROUTER_API_KEY` in console.log), Required missing empty-result/validation/auth handling, with severity labels per skill format.
- ST-SKILL-002 — **PASS** (2026-08-29): precedence/conflict test executed on a real recorded conflict — `code-review-and-quality/references/performance-checklist.md` lines 195–203 recommend `npx lighthouse`/`npx webpack-bundle-analyzer`/`npx vite-bundle-visualizer`/`npx bundlesize`; repo AGENTS.md forbids npm/yarn/npx. Resolution per binding precedence order: repo instruction (level 2) wins over generic skill advice (level 6); npx commands are never executed; pnpm-native equivalent used only if a concrete requirement arises. Conflict recorded here, not silently resolved.
- ST-SKILL-003 — **PASS** (2026-08-29): non-trigger test — unrelated session activity (reading Phase 1 docs, grep, git state review) invoked zero skills; all three skill invocations in this session were explicit and test-scoped. No skill auto-triggered a costly or scope-expanding workflow. Frontmatter of installed skills contains no hooks/injections that could force invocation (CT-SKILL-002).
