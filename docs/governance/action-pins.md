# GitHub Actions dependency pins (Phase 1.1)

Every `uses:` in the enabled workflows is pinned to a full 40-character commit SHA, verified on 2026-09-01 as a real commit of the official source repository (`gh api repos/<owner>/<repo>/commits/<sha>` → 200 with the release-prep commit message). Repository setting `sha_pinning_required=true` enforces this for future edits.

| Action | Pinned SHA | Release | Source repo |
|---|---|---|---|
| actions/checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 | github.com/actions/checkout |
| pnpm/action-setup | `0977fd99725f1db4007ccb2928dbb4e90d06cc86` | v6.0.10 | github.com/pnpm/action-setup |
| actions/setup-node | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0 | github.com/actions/setup-node |
| actions/cache | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | v6.1.0 | github.com/actions/cache |
| actions/upload-artifact | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | v7.0.1 | github.com/actions/upload-artifact |

Removed rather than pinned: `nick-fields/retry` (build.yaml, e2e.yaml) — replaced by a three-attempt shell loop; a third-party action is not justified for bounded retry.

Allowed actions policy (repository setting): GitHub-owned + explicit pattern `pnpm/action-setup@*` only (`verified_allowed=false`).

Update procedure: bump the SHA and release comment together; verify the new SHA against the official repo before merging; never use floating tags.

Sources consulted (2026-09-01): [Secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use), [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), [Disabling and enabling a workflow](https://docs.github.com/en/actions/managing-workflow-runs/disabling-and-enabling-a-workflow), [Preventing changes to your releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).
