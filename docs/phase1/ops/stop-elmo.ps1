# Controlled stop of the Elmo stack (containers only; Docker Desktop stays up
# unless -IncludeEngine). Uses compose stop - data and containers are kept.
param(
    [string]$ConfigDir,
    [string]$Project,
    [string]$RepoRoot,
    [string[]]$ExtraComposeFiles,
    [switch]$IncludeEngine
)
. (Join-Path $PSScriptRoot "elmo-common.ps1")
$ctx = Get-ElmoDefaults -ConfigDir $ConfigDir -Project $Project -RepoRoot $RepoRoot -ExtraComposeFiles $ExtraComposeFiles

Write-ElmoLog $ctx "INFO" "controlled stop requested (project=$($ctx.Project), engine=$IncludeEngine)"
Invoke-ElmoCompose $ctx @("stop") | Out-Null
Write-ElmoLog $ctx "INFO" "stack stopped"
if ($IncludeEngine) {
    & (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe") desktop stop 2>&1 | Out-Null
    Write-ElmoLog $ctx "INFO" "docker desktop stop issued"
}
