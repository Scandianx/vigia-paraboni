param(
    [string]$TaskName = 'ParaboniMonitor',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'src\index.js'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $projectRoot 'config.json'
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path $ConfigPath)) { throw "Configuracao nao encontrada: $ConfigPath" }

$arguments = "`"$entryPoint`" --config=`"$ConfigPath`""
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Tarefa $TaskName registrada e iniciada."
