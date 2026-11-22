# Pizza Room - pechat zakazov na kuhnyu. Rabotaet nezametno, zapuskaetsya vmeste s Windows.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'log.txt'
function Log($m) {
  try {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log ($log + '.old') -Force }
    Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8
  } catch {}
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\PizzaRoomKitchenPrint', [ref]$created)
if (-not $created) { exit }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $dir 'printer.cs'))) -ReferencedAssemblies System.Drawing
$cfg = [IO.File]::ReadAllText((Join-Path $dir 'config.json')) | ConvertFrom-Json
$servers = @($cfg.servers)
$font = if ($cfg.font) { $cfg.font } else { 'Sylfaen' }
$width = if ($cfg.width) { [int]$cfg.width } else { 576 }
$script:srv = $servers[0]

function Call($method, $path) {
  $last = $null
  foreach ($s in (@($script:srv) + ($servers | Where-Object { $_ -ne $script:srv }))) {
    try {
      $wc = New-Object Net.WebClient
      $wc.Encoding = [Text.Encoding]::UTF8
      $wc.Headers.Add('x-print-key', $cfg.key)
      $wc.Headers.Add('content-type', 'application/json')
      if ($method -eq 'GET') { $r = $wc.DownloadString($s + $path) } else { $r = $wc.UploadString($s + $path, 'POST', $script:body) }
      $script:srv = $s
      return $r
    } catch {
      $last = $_
      if ($_.Exception.InnerException -and $_.Exception.InnerException.Response -and [int]$_.Exception.InnerException.Response.StatusCode -eq 401) { throw 'KEY' }
    }
  }
  throw $last
}

function PrintJob($j) {
  $L = @($j.lines)
  $t = New-Object 'string[]' $L.Count; $s = New-Object 'single[]' $L.Count; $b = New-Object 'bool[]' $L.Count
  $a = New-Object 'string[]' $L.Count; $ln = New-Object 'bool[]' $L.Count; $iv = New-Object 'bool[]' $L.Count
  for ($i = 0; $i -lt $L.Count; $i++) {
    $x = $L[$i]
    $t[$i] = [string]$x.t
    $s[$i] = if ($x.s) { [single]$x.s } else { [single]12 }
    $b[$i] = [bool]$x.b; $a[$i] = [string]$x.a; $ln[$i] = [bool]$x.line; $iv[$i] = [bool]$x.inv
  }
  $copies = if ($cfg.copies) { [int]$cfg.copies } else { 1 }
  for ($c = 0; $c -lt $copies; $c++) { [PRPrint]::Ticket($cfg.printer, $t, $s, $b, $a, $ln, $iv, $font, $width, $true, 'Pizza Room ' + $j.no) }
}

Log ('start, printer: ' + $cfg.printer)
$fails = 0
while ($true) {
  try {
    $script:body = '{}'
    $jobs = ConvertFrom-Json (Call 'GET' '/api/print/kitchen')
    foreach ($j in $jobs) {
      if ($null -eq $j) { continue }
      PrintJob $j
      Call 'POST' ('/api/print/kitchen/' + $j.id + '/done') | Out-Null
      Log ('printed ' + $j.no + ' (id ' + $j.id + ')')
    }
    $fails = 0
    Start-Sleep -Seconds 3
  } catch {
    $msg = [string]$_
    if ($msg -eq 'KEY') { Log 'wrong key - create a new key in admin settings'; Start-Sleep -Seconds 60; continue }
    $fails++
    Log ('error: ' + $msg)
    if ($fails -eq 3 -or ($fails % 100) -eq 0) {
      try { $script:body = (@{ msg = ($msg.Substring(0, [Math]::Min(180, $msg.Length))) } | ConvertTo-Json -Compress); Call 'POST' '/api/print/error' | Out-Null } catch {}
    }
    Start-Sleep -Seconds ([Math]::Min(30, 3 * $fails))
  }
}
