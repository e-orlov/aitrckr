# Installs the three aitrckr/ELMO Scheduled Tasks:
#   aitrckr-elmo-startup  - at system startup (2 min delay), runs start-elmo.ps1
#   aitrckr-elmo-watchdog - every 5 minutes, runs watchdog-elmo.ps1
#   aitrckr-elmo-logon-marker - at any user logon, stamps the first-logon
#                               marker used by the cold-boot acceptance test
# Startup + watchdog run "whether user is logged on or not" via an S4U
# principal: no password is stored anywhere (domain password rotation cannot
# break the tasks). If Docker Desktop refuses to start under S4U, the
# documented fallback is switching the task to a password principal in the
# Task Scheduler GUI, where Windows collects the password in its own secure
# dialog. Touches only tasks named aitrckr-elmo-*; remove with remove-tasks.ps1.
param(
    [string]$ConfigDir,
    [string]$Project,
    [string]$RepoRoot,
    [string[]]$ExtraComposeFiles,
    # Interactive-only principal (no password prompt); the startup task then
    # runs only when the user is logged on - NOT sufficient for production
    # acceptance, useful only for rehearsal.
    [switch]$InteractiveOnly,
    # Account the tasks run under. Registration may happen elevated as a
    # DIFFERENT admin account, but the stack must run as the Docker Desktop
    # per-user install owner.
    [string]$TaskUser = "MEDIAWORXDE\orlov"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = "C:\Users\orlov\Claude-Desktop-Projects\aitrckr" }
if (-not $ConfigDir) { $ConfigDir = Join-Path $env:USERPROFILE ".elmo" }
if (-not $Project) { $Project = "elmo" }

$common = "-ConfigDir `"$ConfigDir`" -Project `"$Project`" -RepoRoot `"$RepoRoot`""
if ($ExtraComposeFiles) {
    $joined = ($ExtraComposeFiles | ForEach-Object { "`"$_`"" }) -join ","
    $common += " -ExtraComposeFiles $joined"
}
$ps = "powershell.exe"
$psArgs = "-NoProfile -ExecutionPolicy Bypass -File"

$user = $TaskUser

function New-ElmoTask {
    param([string]$Name, [string]$Script, $Trigger, [switch]$Interactive)
    $action = New-ScheduledTaskAction -Execute $ps -Argument "$psArgs `"$here\$Script`" $common"
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    if ($Interactive) {
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
    } else {
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U
    }
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings -Principal $principal | Out-Null
    Write-Output "installed: $Name (logon type: $($principal.LogonType))"
}

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = "PT2M"
New-ElmoTask -Name "aitrckr-elmo-startup" -Script "start-elmo.ps1" -Trigger $startupTrigger -Interactive:$InteractiveOnly

# [TimeSpan]::MaxValue serializes to an invalid task-XML Duration; ten years
# of 5-minute repetitions is effectively indefinite and serializes cleanly.
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
New-ElmoTask -Name "aitrckr-elmo-watchdog" -Script "watchdog-elmo.ps1" -Trigger $watchTrigger -Interactive:$InteractiveOnly

# Logon marker always runs interactively (fires at logon, so the user is there).
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$markerCmd = "-NoProfile -Command `"New-Item -ItemType Directory -Force -Path '$ConfigDir\logs' | Out-Null; if (-not (Test-Path '$ConfigDir\logs\first-logon.marker')) { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') | Set-Content '$ConfigDir\logs\first-logon.marker' }`""
$mAction = New-ScheduledTaskAction -Execute $ps -Argument $markerCmd
Unregister-ScheduledTask -TaskName "aitrckr-elmo-logon-marker" -Confirm:$false -ErrorAction SilentlyContinue
$mPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
Register-ScheduledTask -TaskName "aitrckr-elmo-logon-marker" -Action $mAction -Trigger $logonTrigger -Principal $mPrincipal | Out-Null
Write-Output "installed: aitrckr-elmo-logon-marker"
