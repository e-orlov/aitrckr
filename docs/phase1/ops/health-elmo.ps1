# Standalone health probe: prints one status line, exit 0 = healthy.
param(
    [string]$ConfigDir,
    [string]$Project,
    [string]$RepoRoot,
    [string[]]$ExtraComposeFiles
)
. (Join-Path $PSScriptRoot "elmo-common.ps1")
$ctx = Get-ElmoDefaults -ConfigDir $ConfigDir -Project $Project -RepoRoot $RepoRoot -ExtraComposeFiles $ExtraComposeFiles

if (-not (Test-DockerEngine)) {
    Write-Output "UNHEALTHY: docker engine not running"
    exit 1
}
$h = Test-ElmoHealth $ctx
if ($h.Healthy) {
    Write-Output "HEALTHY: postgres/web/worker running, web HTTP $($h.HttpCode)"
    exit 0
}
Write-Output ("UNHEALTHY: " + ($h.Problems -join ", "))
exit 1
