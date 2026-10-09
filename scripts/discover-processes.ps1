$ErrorActionPreference = 'Stop'

$servicesByPid = @{}
Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
    $key = [string]$_.ProcessId
    if (-not $servicesByPid.ContainsKey($key)) { $servicesByPid[$key] = @() }
    $servicesByPid[$key] += $_.Name
}

Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in @('node.exe', 'java.exe', 'javaw.exe', 'tomcat.exe', 'tomcat9.exe', 'tomcat10.exe') } |
    ForEach-Object {
        $key = [string]$_.ProcessId
        [pscustomobject]@{
            PID = $_.ProcessId
            Name = $_.Name
            Services = if ($servicesByPid.ContainsKey($key)) { $servicesByPid[$key] -join ', ' } else { '' }
            ExecutablePath = $_.ExecutablePath
            CommandLine = $_.CommandLine
        }
    } | Format-List
