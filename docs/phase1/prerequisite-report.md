# Phase 1 — Prerequisite report (stage B)

Diagnostics run 2026-08-29 ~09:25 UTC on the target VM. All commands executed locally; verdicts based on actual output.

| # | Check | Command/source | Actual result | Verdict |
|---|---|---|---|---|
| 1 | Windows edition/build/arch | `Get-CimInstance Win32_OperatingSystem` | Windows 10 Pro, build 19045, 64-bit (matches known 19045.6456) | PASS |
| 2 | Account/elevation | PowerShell WindowsPrincipal | `MEDIAWORXDE\orlov` — **domain account**, process not elevated (Admin: False) | WARN — Docker Desktop install and ONSTART Scheduled Tasks will require UAC/admin credentials (user checkpoints) |
| 3 | CPU/RAM/disk | Win32_ComputerSystem, Get-PSDrive | 16 logical CPU; 15.6 GB RAM (≈10.3 GB free); C: 57.2 GB free / 69.2 GB used | PASS |
| 4 | PowerShell/installer | `$PSVersionTable`, `winget --version` | PowerShell 5.1.19041.6456 (German locale); winget v1.29.290 | PASS |
| 5 | Git + credential helper | `git --version`, `git config credential.helper` | git 2.54.0.windows.1; helper = `manager` (Git Credential Manager, system+global) | PASS |
| 6 | Git author identity | `git config user.name/email` | both unset | WARN — user checkpoint required before first commit |
| 7 | GitHub CLI | `where.exe gh` | not installed → **installed 2026-08-29T09:34Z**: gh 2.98.0, per-user via `winget install --id GitHub.cli --scope user`; auth not yet configured | PASS (install); auth pending browser checkpoint |
| 8 | Claude Code runtime | session environment | Claude Code agent inside Claude Desktop (win32); `claude` CLI not on PATH; skill locations: bundled/plugin set + project `.claude/skills/`; **top-level `.claude/skills/` did not exist at session start** (folder held only the master prompt) | WARN — session reload checkpoint expected for skill discovery (MP §7.C.10) |
| 9 | Node | `where.exe node`, `node --version` | `C:\Program Files\nodejs\node.exe`, v24.16.0 — satisfies `engines: 24.x` and `.nvmrc` 24 | PASS |
| 10 | pnpm / Corepack | `pnpm --version`, `corepack --version` | pnpm absent → **activated 2026-08-29T09:34Z**: `corepack enable` denied EPERM on Program Files (non-elevated, as predicted) → per-user fallback `corepack enable --install-directory %LOCALAPPDATA%\corepack-shims` + user PATH prepend; `pnpm --version` = 11.18.0 (exact `packageManager` match, fetched by corepack from registry.npmjs.org) | PASS |
| 11 | WSL | `wsl --version`, `wsl -l -v` | WSL 2.7.12.0, kernel 6.18.33.2-2; Ubuntu-24.04, version 2, state Stopped→starts on demand | PASS |
| 12 | WSL systemd + resources | `systemctl is-system-running`, `free`, `nproc` | `running`; 7.6 GiB RAM (6.9 available), 2 GiB swap, 16 CPU | PASS |
| 13 | Docker | `where.exe docker`, Program Files, WSL distros | **Docker Desktop not installed**: no CLI, no `Docker Desktop.exe`, no docker-desktop WSL distros; only leftover `%LOCALAPPDATA%\Docker\log` from a prior install | WARN — fresh install at stage C; leftover log dir untouched |
| 14 | Ports 1515/3000/3001/5432 | `Get-NetTCPConnection -State Listen` | all free | PASS |
| 15 | Windows HTTPS/DNS | curl to GitHub/npm/Docker registry/OpenRouter | 200 / 200 / 401 (expected auth challenge — reachable) / 200 | PASS |
| 16 | WSL HTTPS/DNS | getent + curl inside Ubuntu-24.04 | DNS OK; OpenRouter HTTPS 200 | PASS |
| 17 | Scheduled Tasks | `schtasks /query` (read-only) | query works; existing tasks visible; creation of ONSTART / "run whether user is logged on or not" task not attempted (needs elevation and/or password — deferred to stage K per MP: no password prompts during diagnostics) | WARN — likely UAC/admin checkpoint at stage K; domain password rotation risk to be clarified then |
| 18 | Repo toolchain requirements | package.json, pnpm-workspace.yaml @b3bea1e | Node 24.x + pnpm 11.18.0 + Turborepo + Biome 2.5.8 + Vitest + Playwright; supply-chain: minimumReleaseAge, trustPolicy no-downgrade, blockExoticSubdeps, allowBuilds | PASS (constraints registered as REQ-ENV-002/003) |

No BLOCKED items. WARN items have planned resolution stages and user checkpoints.

## Verification design status (GATE-L2 input)

- Every active `REQ-*` row in [requirements-matrix.md](requirements-matrix.md) carries risk, verification level/method, Test ID(s), preconditions, measurable expected result and evidence plan — assigned before any install/change.
- Skills: selection table with verdicts, source-lock plan (SHA `d2c37ef`), supporting-file plan (all candidates self-contained — no shared references to copy), invocation policy, precedence/conflict rules and qualification test plan (`CT/IT/ST-SKILL-*`) are in [agent-skills-qualification.md](agent-skills-qualification.md).
- Minimal technical path chosen: corepack-based pnpm, winget gh, fresh Docker Desktop install (primary backend), CLI-generated Compose with pinned images as production basis.
