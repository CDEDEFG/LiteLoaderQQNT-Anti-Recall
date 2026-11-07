# 从当前用户已登录 QQ 进程读取 SQLCipher 密钥候选。
# 仅返回匹配本地数据库 salt 的候选，不写密钥文件、不打印密钥正文。
param(
  [Parameter(Mandatory = $true)][string]$DbDir,
  [int]$TargetPid = 0,
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $DbDir)) { throw "DbDir not found: $DbDir" }

# ---------- 1. 读出所有目标库的 salt ----------
# QQ 库 = 1024 字节自定义头 + [1024,1040) 的 salt。空库(1024 字节)跳过。
$salts = @{}
Get-ChildItem -LiteralPath $DbDir -Filter *.db | ForEach-Object {
  $f = $_
  if ($f.Length -lt 5120) { return }
  $fs = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
  try {
    $buf = New-Object byte[] 1040
    $n = $fs.Read($buf, 0, 1040)
    if ($n -lt 1040) { return }
    $isQQ = [System.Text.Encoding]::ASCII.GetString($buf, 0, 16) -eq "SQLite header 3`0"
    $off = if ($isQQ) { 1024 } else { 0 }
    $hex = -join ($buf[$off..($off + 15)] | ForEach-Object { $_.ToString('x2') })
    $salts[$f.Name] = $hex
  } finally { $fs.Close() }
}
if ($salts.Count -eq 0) { throw "no usable .db found under $DbDir" }
Write-Host ("salt: " + $salts.Count + " db") -ForegroundColor Cyan

# ---------- 2. 找加载了 wrapper.node 的 QQ 进程 ----------
# 这是整个流程的关键：QQ 会起好几个进程，但只有启动器那个主进程才 dlopen wrapper.node，
# 而 SQLCipher 代码和 key 字符串只在 wrapper.node 里。
function Get-WrapperProcesses {
  $found = @()
  foreach ($p in (Get-Process -Name QQ -ErrorAction SilentlyContinue)) {
    try {
      $m = $p.Modules | Where-Object { $_.ModuleName -eq 'wrapper.node' }
      if ($m) {
        $found += [pscustomobject]@{
          Pid    = $p.Id
          Base   = ('0x{0:X}' -f $m.BaseAddress.ToInt64())
          Path   = $m.FileName
          WsMB   = [int]($p.WorkingSet64 / 1MB)
        }
      }
    } catch { }
  }
  return $found
}

if ($TargetPid -ne 0) {
  $targets = @([pscustomobject]@{ Pid = $TargetPid; Base = '?'; Path = 'user-specified'; WsMB = 0 })
} else {
  $targets = Get-WrapperProcesses
  if (-not $targets -or $targets.Count -eq 0) {
    Write-Host "没有 QQ 进程加载 wrapper.node。" -ForegroundColor Yellow
    Write-Host "请确认：1) QQ 已启动并登录  2) 用管理员 PowerShell 运行  3) 试 -TargetPid 指定主进程" -ForegroundColor Yellow
    Write-Host "当前 QQ 进程：" -ForegroundColor Yellow
    Get-Process -Name QQ -ErrorAction SilentlyContinue |
      Select-Object Id, @{n = 'MB'; e = { [int]($_.WorkingSet64 / 1MB) } }, StartTime | Format-Table | Out-String | Write-Host
    exit 2
  }
}

# ---------- 3. 编译扫描器 ----------
$csPath = Join-Path $PSScriptRoot 'lib\MemScan.cs'
$src = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop

# ---------- 4. 扫 ----------
$saltList = [string[]]($salts.Values | Select-Object -Unique)
$all = @{}
foreach ($t in $targets) {
  Write-Host ("scan pid=" + $t.Pid + " wrapper=" + $t.Path + " ws=" + $t.WsMB + "MB") -ForegroundColor Cyan
  $r = [QQKeyScan]::Scan($t.Pid, $saltList)
  $lines = $r -split "`n"
  Write-Host ("  " + $lines[0])
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $ln = $lines[$i].Trim()
    if (-not $ln) { continue }
    $all[$ln] = $true
  }
}

# ---------- 5. 只返回候选，不落盘，不打印敏感内容 ----------
$out = @($all.Keys | Sort-Object)
Write-Host ("找到 " + $out.Count + " 条候选（仅内存返回）")
$out | ForEach-Object { Write-Output $_ }
