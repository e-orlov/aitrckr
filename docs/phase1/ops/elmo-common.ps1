# Shared helpers for the Elmo Phase 1 operations scripts. Dot-source only.
# No secrets are read or written here; logs carry timestamps and statuses only.

$ErrorActionPreference = "Stop"

$script:DockerDesktopExe = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"
$script:DockerCli = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"
# These scripts live at <repo-root>\docs\phase1\ops, so the repo root is three
# levels up; -RepoRoot overrides for out-of-tree copies.
$script:ElmoRepoRootDefault = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path

function Get-ElmoDefaults {
    param([string]$ConfigDir, [string]$Project, [string]$RepoRoot, [string[]]$ExtraComposeFiles)
    if (-not $ConfigDir) { $ConfigDir = Join-Path $env:USERPROFILE ".elmo" }
    if (-not $Project) { $Project = "elmo" }
    if (-not $RepoRoot) { $RepoRoot = $script:ElmoRepoRootDefault }
    $files = @((Join-Path $ConfigDir "elmo.yaml"), (Join-Path $RepoRoot "docs\phase1\ops\prod-env.override.yaml"))
    if ($ExtraComposeFiles) { $files += $ExtraComposeFiles }
    [pscustomobject]@{
        ConfigDir = $ConfigDir
        Project   = $Project
        RepoRoot  = $RepoRoot
        ComposeFiles = $files
        LogDir    = Join-Path $ConfigDir "logs"
        WebUrl    = "http://127.0.0.1:1515/"
    }
}

function Write-ElmoLog {
    param($Ctx, [string]$Level, [string]$Message)
    New-Item -ItemType Directory -Force -Path $Ctx.LogDir | Out-Null
    $log = Join-Path $Ctx.LogDir "elmo-ops.log"
    # Size-based rotation: keep one predecessor, bound total size.
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
        Move-Item -Force $log "$log.1"
    }
    $line = "{0} [{1}] {2}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $Level, $Message
    Add-Content -Path $log -Value $line
    Write-Output $line
}

function Invoke-ElmoCompose {
    param($Ctx, [string[]]$ComposeArgs)
    $env:COMPOSE_PATH_SEPARATOR = ";"
    $env:COMPOSE_FILE = ($Ctx.ComposeFiles -join ";")
    $env:COMPOSE_PROJECT_NAME = $Ctx.Project
    # Compose writes progress to stderr; under EAP=Stop PowerShell 5.1 turns
    # redirected stderr into a terminating NativeCommandError - relax locally.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # Progress lines go to the console only - the function's return value
        # must stay a bare exit code (PowerShell returns ALL pipeline output).
        & $script:DockerCli compose @ComposeArgs 2>&1 | ForEach-Object { Write-Host "$_" }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Test-DockerEngine {
    if (-not (Test-Path $script:DockerCli)) { return $false }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $script:DockerCli version --format "{{.Server.Version}}" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

# DEF-001: Docker Desktop on this VM reliably crashes on a stale
# docker-secrets-engine\engine.sock after any stop->start cycle. The stale
# socket file is undeletable until reboot, so the directory is renamed aside.
function Clear-StaleDockerState {
    param($Ctx)
    Get-Process -Name "docker", "docker-desktop", "com.docker.backend", "com.docker.build" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $d = Join-Path $env:LOCALAPPDATA "docker-secrets-engine"
    if (Test-Path $d) {
        $target = "$d-stale-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        try {
            Rename-Item $d $target -ErrorAction Stop
            Write-ElmoLog $Ctx "INFO" "DEF-001 cleanup: renamed stale secrets-engine dir aside"
        } catch {
            Write-ElmoLog $Ctx "WARN" "DEF-001 cleanup: rename failed: $($_.Exception.Message)"
        }
    }
    # Older stale copies become deletable after a reboot - sweep quietly.
    Get-ChildItem "$env:LOCALAPPDATA" -Directory -Filter "docker-secrets-engine-stale*" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

function Start-DockerEngine {
    param($Ctx, [int]$TimeoutSec = 300)
    if (Test-DockerEngine) { return $true }
    Clear-StaleDockerState $Ctx
    Write-ElmoLog $Ctx "INFO" "starting Docker Desktop"
    Start-Process -FilePath $script:DockerDesktopExe -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $delay = 5
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $delay
        if (Test-DockerEngine) {
            Write-ElmoLog $Ctx "INFO" "Docker engine ready"
            return $true
        }
        if ($delay -lt 20) { $delay += 5 }
    }
    Write-ElmoLog $Ctx "ERROR" "Docker engine did not become ready within ${TimeoutSec}s"
    return $false
}

function Test-ElmoHealth {
    param($Ctx)
    $bad = @()
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        foreach ($svc in @("postgres", "web", "worker")) {
            $name = "$($Ctx.Project)-$svc-1"
            $state = & $script:DockerCli inspect --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $name 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $state) { $bad += "${svc}:missing"; continue }
            $parts = $state -split "\|"
            if ($parts[0] -ne "running") { $bad += "${svc}:$($parts[0])"; continue }
            if ($parts[1] -notin @("none", "healthy")) { $bad += "${svc}:$($parts[1])" }
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    try {
        $resp = Invoke-WebRequest -Uri $Ctx.WebUrl -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10 -ErrorAction Stop
        $code = [int]$resp.StatusCode
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    }
    if ($code -lt 200 -or $code -ge 500) { $bad += "web-http:$code" }
    [pscustomobject]@{ Healthy = ($bad.Count -eq 0); Problems = $bad; HttpCode = $code }
}
