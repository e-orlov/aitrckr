<!-- Fork governance: docs/governance/branching-and-release-policy.md -->

## What

<!-- One paragraph: what changes and why. -->

## Checklist

- [ ] Branch is short-lived `feat/*` / `fix/*` / `chore/*` / `hotfix/*` / `sync/upstream-vX.Y.Z`
- [ ] Merge method: **squash** for own work, **merge commit** for `sync/upstream-*` (never rebase)
- [ ] `pnpm lint` passes; no `biome-ignore` added
- [ ] No secrets, `.env` contents, or personal machine paths in the diff
- [ ] Workflow edits keep: GitHub-hosted runner, full-SHA action pins, `contents: read`, no `secrets.*`
- [ ] No production mutation from CI; deploys stay manual per `docs/phase1/production-manifest.md`
- [ ] Changeset added only for user-facing changes
- [ ] For `sync/upstream-*`: exact release tag verified, migrations risk-reviewed, fork-only surfaces preserved
