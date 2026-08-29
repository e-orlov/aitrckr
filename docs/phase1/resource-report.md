# Phase 1 — resource report (stage F)

Measured on the target VM (16 vCPU Xeon Gold 6230, 15.6 GB dynamic RAM, 127 GB disk) with `date -u`-verified UTC timestamps; commands: `Get-CimInstance Win32_OperatingSystem`, `wsl -d docker-desktop free -m`, `docker stats --no-stream`, `df -h /c`, `docker system df`.

## Measurements (2026-08-29)

| Phase | Windows free RAM | WSL (used/available of 7748 MB) | Swap used | Containers (CPU / mem) | Disk free C: |
|---|---|---|---|---|---|
| Heavy phases (install 2m57s, build 1m9s, unit tests 1m23s) | not sampled live — completed without failures/OOM; durations recorded in baseline-report | — | — | — | — |
| E2E load: web serving 39-test Playwright run + 2×postgres (~11:55Z) | 5.2 GB | 1695 used / 5803 available | 12 MB | web 1.6% / 321 MB; test-pg 74 MB; dev-pg 38 MB | 32 GB (75% used) |
| Production-like: web + worker + 2×postgres idle (~12:00Z) | 5.6 GB | comparable | ~12 MB | worker 398 MB; web 189 MB; test-pg 72 MB; dev-pg 37 MB | 32 GB |

Synthetic batch (stub worker job via worker E2E spec) processed within the same envelope — worker peak observed 398 MB.

## Verdict (REQ-RESRC-001)

- **Current ~7.6 GiB WSL RAM is sufficient** for build + tests + production-like stack: no OOM events, swap essentially untouched (12 MB), >5 GB available inside WSL and >5 GB free on Windows at all sampled points.
- **No `.wslconfig` change recommended** on this data.
- **Disk watch item:** C: at 75% (32 GB free). Docker build cache holds 11.22 GB reclaimable — the single biggest consumer. Do NOT auto-prune (MP §5.1); if disk pressure appears, ask the user before `docker builder prune`. Container log rotation is mandatory in production compose (stage L) to bound growth.
- Re-measure at stage J/K (crash/reboot tests) and after production cutover with real schedules.
