# Elmo watchdog (Scheduled Task, every 5 minutes). Recovers a stopped engine
# (including the DEF-001 stale-socket crash), restarts unhealthy or missing
# services (a container stuck "unhealthy" is NOT revived by the restart
# policy - established at stage J), and never creates a second stack
# (compose up on an existing project is a no-op for healthy services).
param(
    [string]$ConfigDir,
    [string]$Project,
    [string]$RepoRoot,
    [string[]]$ExtraComposeFiles
)
. (Join-Path $PSScriptRoot "elmo-common.ps1")
$ctx = Get-ElmoDefaults -ConfigDir $ConfigDir -Project $Project -RepoRoot $RepoRoot -ExtraComposeFiles $ExtraComposeFiles

$mutex = New-Object System.Threading.Mutex($false, "Global\aitrckr-elmo-ops")
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    if (-not (Test-DockerEngine)) {
        Write-ElmoLog $ctx "WARN" "watchdog: engine down - recovering"
        if (-not (Start-DockerEngine $ctx)) { exit 1 }
        Invoke-ElmoCompose $ctx @("up", "-d", "--no-build") | Out-Null
        Start-Sleep -Seconds 30
    }

    $h = Test-ElmoHealth $ctx
    if ($h.Healthy) { exit 0 }

    Write-ElmoLog $ctx "WARN" ("watchdog: problems: " + ($h.Problems -join ", ") + " - restarting affected services")
    foreach ($p in $h.Problems) {
        $svc = ($p -split ":")[0]
        if ($svc -in @("postgres", "web", "worker")) {
            Invoke-ElmoCompose $ctx @("restart", $svc) | Out-Null
        }
    }
    Invoke-ElmoCompose $ctx @("up", "-d", "--no-build") | Out-Null

    Start-Sleep -Seconds 45
    $h2 = Test-ElmoHealth $ctx
    if ($h2.Healthy) {
        Write-ElmoLog $ctx "INFO" "watchdog: recovery successful"
        exit 0
    }
    Write-ElmoLog $ctx "ERROR" ("watchdog: recovery FAILED: " + ($h2.Problems -join ", "))
    exit 1
} finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
