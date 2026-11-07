# ASCII-only PowerShell 5.1 entry point. Output is a single JSON status line.
# Secret candidates are returned to the parent process only; never written to disk.
param(
  [Parameter(Mandatory = $true)][string]$DbDir,
  [int]$TargetPid = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Result($code, $message, $pairs) {
  [PSCustomObject]@{
    ok = ($code -eq 'OK')
    code = $code
    message = $message
    candidates = @($pairs)
  } | ConvertTo-Json -Compress -Depth 4
  exit $(if ($code -eq 'OK') { 0 } else { 1 })
}

try {
  if (-not (Test-Path -LiteralPath $DbDir)) { Write-Result 'NO_DB' 'Database directory not found' @() }

  $salts = @{}
  Get-ChildItem -LiteralPath $DbDir -Filter *.db | ForEach-Object {
    $file = $_
    if ($file.Length -lt 5120) { return }
    $stream = [System.IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite')
    try {
      $buffer = New-Object byte[] 1040
      $count = $stream.Read($buffer, 0, 1040)
      if ($count -lt 1040) { return }
      $offset = 0
      if ([System.Text.Encoding]::ASCII.GetString($buffer, 0, 16) -eq "SQLite header 3`0") { $offset = 1024 }
      $hex = -join ($buffer[$offset..($offset + 15)] | ForEach-Object { $_.ToString('x2') })
      $salts[$file.Name] = $hex
    } finally { $stream.Close() }
  }
  if ($salts.Count -eq 0) { Write-Result 'NO_DB' 'No usable QQ database found' @() }

  $targets = @()
  if ($TargetPid -ne 0) {
    $targets += [PSCustomObject]@{ Pid = $TargetPid }
  } else {
    foreach ($process in (Get-Process -Name QQ -ErrorAction SilentlyContinue)) {
      try {
        $module = $process.Modules | Where-Object { $_.ModuleName -eq 'wrapper.node' }
        if ($module) { $targets += [PSCustomObject]@{ Pid = $process.Id } }
      } catch {}
    }
  }
  if ($targets.Count -eq 0) { Write-Result 'NO_QQ' 'QQ is not logged in or wrapper.node is not loaded' @() }

  $source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'lib\MemScan.cs'), [System.Text.Encoding]::UTF8)
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  $wanted = [string[]]($salts.Values | Select-Object -Unique)
  $pairs = @{}
  foreach ($target in $targets) {
    $result = [QQKeyScan]::Scan($target.Pid, $wanted) -split "`n"
    foreach ($line in $result) {
      $line = $line.Trim()
      if ($line -match '^[0-9a-fA-F]{64} [0-9a-fA-F]{32}$') { $pairs[$line.ToLowerInvariant()] = $true }
    }
  }
  if ($pairs.Count -eq 0) { Write-Result 'NO_KEY' 'No SQLCipher key candidate matched this database' @() }
  Write-Result 'OK' 'Key candidates loaded in memory' @($pairs.Keys)
} catch {
  Write-Result 'SCAN_ERROR' $_.Exception.Message @()
}
