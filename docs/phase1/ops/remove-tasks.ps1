# Removes ONLY the aitrckr-elmo-* Scheduled Tasks installed by install-tasks.ps1.
$ErrorActionPreference = "SilentlyContinue"
foreach ($name in @("aitrckr-elmo-startup", "aitrckr-elmo-watchdog", "aitrckr-elmo-logon-marker")) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Output "removed: $name"
    } else {
        Write-Output "not present: $name"
    }
}
