$ErrorActionPreference = 'Stop'
$failures = @()

function Test-Step([string]$Name, [scriptblock]$Action) {
    try {
        & $Action | Out-Null
        Write-Host "OK   $Name"
    } catch {
        $script:failures += "$Name`: $($_.Exception.Message)"
        Write-Host "FAIL $Name - $($_.Exception.Message)" -ForegroundColor Red
    }
}

Test-Step 'Node.js 18+' {
    $versionText = (& node.exe --version).Trim().TrimStart('v')
    $version = [version]$versionText
    if ($version.Major -lt 18) { throw "versao encontrada: $versionText" }
}

Test-Step 'CIM sistema operacional' {
    Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Select-Object -First 1 | Out-Null
}

Test-Step 'CIM catalogo de processos' {
    Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object -First 1 | Out-Null
}

Test-Step 'CIM servicos Windows' {
    Get-CimInstance Win32_Service -ErrorAction Stop | Select-Object -First 1 | Out-Null
}

Test-Step 'Contadores de CPU' {
    Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop | Select-Object -First 1 | Out-Null
}

Test-Step 'Contadores de processos' {
    Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop | Select-Object -First 1 | Out-Null
}

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host 'Preflight falhou. Execute em PowerShell elevado e corrija os itens acima.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'Preflight concluido. O servidor oferece as fontes necessarias.' -ForegroundColor Green
