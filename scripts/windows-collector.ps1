param(
    [int]$IntervalSeconds = 5,
    [int]$CatalogRefreshSeconds = 30
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$lastCatalogAt = [DateTime]::MinValue
$logicalProcessors = [int]$env:NUMBER_OF_PROCESSORS
if ($logicalProcessors -le 0) { $logicalProcessors = 1 }
$script:currentWarnings = @()

function Get-CimSafe([string]$ClassName, [string]$Filter = '') {
    try {
        if ([string]::IsNullOrWhiteSpace($Filter)) {
            return Get-CimInstance -ClassName $ClassName -ErrorAction Stop
        }
        return Get-CimInstance -ClassName $ClassName -Filter $Filter -ErrorAction Stop
    } catch {
        $script:currentWarnings += "$ClassName indisponivel: $($_.Exception.Message)"
        return $null
    }
}

try {
    $computer = Get-CimSafe 'Win32_ComputerSystem'
    if ($computer.NumberOfLogicalProcessors -gt 0) {
        $logicalProcessors = [int]$computer.NumberOfLogicalProcessors
    }
} catch {
    # The collector can continue with a conservative default.
}

function Get-NullableNumber($value) {
    if ($null -eq $value) { return $null }
    return [double]$value
}

while ($true) {
    $startedAt = [DateTime]::UtcNow
    $script:currentWarnings = @()

    try {
        $cpu = Get-CimSafe 'Win32_PerfFormattedData_PerfOS_Processor' "Name='_Total'"
        $memory = Get-CimSafe 'Win32_PerfFormattedData_PerfOS_Memory'
        $os = Get-CimSafe 'Win32_OperatingSystem'
        $disk = Get-CimSafe 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk' "Name='_Total'"
        $perfProcessData = Get-CimSafe 'Win32_PerfFormattedData_PerfProc_Process'
        $perfProcesses = @($perfProcessData |
            Where-Object { $null -ne $_ } |
            Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
            ForEach-Object {
                [ordered]@{
                    pid = [int]$_.IDProcess
                    instance = [string]$_.Name
                    cpuRawPercent = (Get-NullableNumber $_.PercentProcessorTime)
                    workingSetBytes = (Get-NullableNumber $_.WorkingSet)
                    privateBytes = (Get-NullableNumber $_.WorkingSetPrivate)
                    threads = (Get-NullableNumber $_.ThreadCount)
                    handles = (Get-NullableNumber $_.HandleCount)
                    ioReadBytesPerSec = (Get-NullableNumber $_.IOReadBytesPersec)
                    ioWriteBytesPerSec = (Get-NullableNumber $_.IOWriteBytesPersec)
                }
            })

        $catalog = $null
        if (([DateTime]::UtcNow - $lastCatalogAt).TotalSeconds -ge $CatalogRefreshSeconds) {
            $servicesByPid = @{}
            $serviceData = Get-CimSafe 'Win32_Service'
            @($serviceData | Where-Object { $null -ne $_ -and $_.ProcessId -gt 0 }) | ForEach-Object {
                $pidKey = [string]$_.ProcessId
                if (-not $servicesByPid.ContainsKey($pidKey)) {
                    $servicesByPid[$pidKey] = @()
                }
                $servicesByPid[$pidKey] += [string]$_.Name
            }

            $processData = Get-CimSafe 'Win32_Process'
            if ($null -ne $processData) {
                $catalog = @($processData | ForEach-Object {
                $pidKey = [string]$_.ProcessId
                $serviceNames = @()
                if ($servicesByPid.ContainsKey($pidKey)) {
                    $serviceNames = @($servicesByPid[$pidKey])
                }
                [ordered]@{
                    pid = [int]$_.ProcessId
                    parentPid = [int]$_.ParentProcessId
                    name = [string]$_.Name
                    executablePath = [string]$_.ExecutablePath
                    commandLine = [string]$_.CommandLine
                    creationDate = $(if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
                    serviceNames = $serviceNames
                }
                })
            }
            $lastCatalogAt = [DateTime]::UtcNow
        }

        $totalMemoryMb = if ($null -ne $os) { [double]$os.TotalVisibleMemorySize / 1024 } else { 0 }
        $availableMemoryMb = if ($null -ne $os) { [double]$os.FreePhysicalMemory / 1024 } else { 0 }

        $sample = [ordered]@{
            type = 'sample'
            timestampUtc = [DateTime]::UtcNow.ToString('o')
            collectionDurationMs = [math]::Round(([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
            logicalProcessors = $logicalProcessors
            system = [ordered]@{
                cpuPercent = (Get-NullableNumber $cpu.PercentProcessorTime)
                totalMemoryMb = [math]::Round($totalMemoryMb, 2)
                availableMemoryMb = [math]::Round($availableMemoryMb, 2)
                availableMemoryPercent = if ($totalMemoryMb -gt 0) { [math]::Round(($availableMemoryMb / $totalMemoryMb) * 100, 2) } else { $null }
                committedMemoryPercent = (Get-NullableNumber $memory.PercentCommittedBytesInUse)
                pagesPerSec = (Get-NullableNumber $memory.PagesPersec)
                diskBusyPercent = (Get-NullableNumber $disk.PercentDiskTime)
                diskQueueLength = (Get-NullableNumber $disk.AvgDiskQueueLength)
                diskReadBytesPerSec = (Get-NullableNumber $disk.DiskReadBytesPersec)
                diskWriteBytesPerSec = (Get-NullableNumber $disk.DiskWriteBytesPersec)
            }
            processes = $perfProcesses
            catalog = $catalog
            collectorWarnings = @($script:currentWarnings)
        }

        [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress -Depth 8))
    } catch {
        $failure = [ordered]@{
            type = 'collector-error'
            timestampUtc = [DateTime]::UtcNow.ToString('o')
            message = $_.Exception.Message
        }
        [Console]::Out.WriteLine(($failure | ConvertTo-Json -Compress))
    }

    Start-Sleep -Seconds $IntervalSeconds
}
