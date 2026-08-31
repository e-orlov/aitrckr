# Elmo startup orchestrator (Scheduled Task ONSTART entry point).
# Idempotent: safe to run repeatedly; a system-wide mutex prevents overlap
# with the watchdog. Writes the startup health marker ONLY after the full
# stack is healthy, so cold-boot acceptance can compare it to first logon.
param(
    [string]$ConfigDir,
    [string]$Project,
    [string]$RepoRoot,
    [string[]]$ExtraComposeFiles
)
. (Join-Path $PSScriptRoot "elmo-common.ps1")
$ctx = Get-ElmoDefaults -ConfigDir $ConfigDir -Project $Project -RepoRoot $RepoRoot -ExtraComposeFiles $ExtraComposeFiles

$mutex = New-Object System.Threading.Mutex($false, "Global\aitrckr-elmo-ops")
if (-not $mutex.WaitOne(0)) { Write-Output "another elmo ops run is active; exiting"; exit 0 }
try {
    Write-ElmoLog $ctx "INFO" "startup orchestrator begin (project=$($ctx.Project))"
    if (-not (Start-DockerEngine $ctx)) { exit 1 }

    $rc = Invoke-ElmoCompose $ctx @("up", "-d", "--no-build")
    if ($rc -ne 0) {
        Write-ElmoLog $ctx "ERROR" "compose up failed (exit $rc)"
        exit 1
    }

    $deadline = (Get-Date).AddSeconds(240)
    do {
        Start-Sleep -Seconds 10
        $h = Test-ElmoHealth $ctx
        if ($h.Healthy) { break }
    } while ((Get-Date) -lt $deadline)

    if ($h.Healthy) {
        $marker = Join-Path $ctx.LogDir "startup-health.marker"
        (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") | Set-Content -Path $marker
        Write-ElmoLog $ctx "INFO" "stack healthy (web HTTP $($h.HttpCode)); startup marker written"
        exit 0
    }
    Write-ElmoLog $ctx "ERROR" ("stack unhealthy after startup: " + ($h.Problems -join ", "))
    exit 1
} finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
