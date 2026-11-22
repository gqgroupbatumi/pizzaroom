$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $env:LOCALAPPDATA 'PizzaRoomPrint'
$servers = @('https://pizzaroom.ge', 'https://pizzaroom.vbatumi1.workers.dev')

Write-Host ''
Write-Host '  PIZZA ROOM — печать заказов на кухню' -ForegroundColor Yellow
Write-Host '  ------------------------------------'
Write-Host ''

# 1. Ключ
Write-Host '1) Ключ принтера: админка → Настройки → «Печать на кухню» → «Создать ключ».'
$key = ''
while ($key -notmatch '^PR-[0-9A-F]{24}$') {
  $key = (Read-Host '   Вставьте ключ (правая кнопка мыши = вставить) и нажмите Enter').Trim().ToUpper()
  if ($key -notmatch '^PR-[0-9A-F]{24}$') { Write-Host '   Ключ должен выглядеть так: PR-ABC123... (27 знаков). Попробуйте ещё раз.' -ForegroundColor Red; continue }
  $ok = $false
  foreach ($s in $servers) {
    try { $wc = New-Object Net.WebClient; $wc.Headers.Add('x-print-key', $key); $null = $wc.DownloadString($s + '/api/print/kitchen'); $ok = $true; break }
    catch { if ($_.Exception.InnerException -and $_.Exception.InnerException.Response -and [int]$_.Exception.InnerException.Response.StatusCode -eq 401) { break } }
  }
  if (-not $ok) { Write-Host '   Ключ не подошёл (или нет интернета). Создайте новый ключ в админке и вставьте его.' -ForegroundColor Red; $key = '' }
}
Write-Host '   [OK] Ключ подошёл' -ForegroundColor Green

# 2. Принтер
Write-Host ''
Write-Host '2) Выберите кухонный принтер:'
$printers = @(Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name)
if ($printers.Count -eq 0) { Write-Host '   В Windows нет ни одного принтера. Установите драйвер Xprinter и запустите снова.' -ForegroundColor Red; Read-Host 'Enter — выход'; exit 1 }
$def = 0
for ($i = 0; $i -lt $printers.Count; $i++) {
  if ($printers[$i] -match 'XP|Xprinter|80|POS|Receipt') { if ($def -eq 0) { $def = $i + 1 } }
  Write-Host ('   ' + ($i + 1) + ') ' + $printers[$i])
}
$n = 0
while ($n -lt 1 -or $n -gt $printers.Count) {
  $q = if ($def) { "   Номер принтера (Enter = $def)" } else { '   Номер принтера' }
  $v = Read-Host $q
  if ($v -eq '' -and $def) { $n = $def } else { [int]::TryParse($v, [ref]$n) | Out-Null }
}
$printer = $printers[$n - 1]
Write-Host ('   [OK] ' + $printer) -ForegroundColor Green

# 3. Копируем программу
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*PizzaRoomPrint*agent.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Milliseconds 500
foreach ($f in 'agent.ps1', 'printer.cs', 'start.vbs') { Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force }
Get-ChildItem $dst | Unblock-File -ErrorAction SilentlyContinue
$cfg = @{ servers = $servers; key = $key; printer = $printer; font = 'Sylfaen'; width = 576; copies = 1 }
[IO.File]::WriteAllText((Join-Path $dst 'config.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

# 4. Пробная печать
Write-Host ''
Write-Host '3) Пробная печать…'
try {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $dst 'printer.cs'))) -ReferencedAssemblies System.Drawing
  $t = [string[]]@('PIZZA ROOM', 'სამზარეულოს პრინტერი ჩართულია', 'Принтер кухни подключён', '', (Get-Date -Format 'dd.MM.yyyy HH:mm'))
  $s = [single[]]@(22, 13, 13, 8, 10); $b = [bool[]]@($true, $true, $false, $false, $false); $a = [string[]]@('c', 'c', 'c', 'c', 'c')
  $l = [bool[]]@($false, $false, $false, $true, $false); $iv = [bool[]]@($false, $false, $false, $false, $false)
  [PRPrint]::Ticket($printer, $t, $s, $b, $a, $l, $iv, 'Sylfaen', 576, $true, 'Pizza Room test')
  Write-Host '   [OK] Отправлено на принтер — должен выйти бланк «Принтер кухни подключён».' -ForegroundColor Green
} catch { Write-Host ('   Не получилось напечатать: ' + $_) -ForegroundColor Red }

# 5. Автозапуск
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item (Join-Path $dst 'start.vbs') (Join-Path $startup 'PizzaRoom-Pechat-Kuhnya.vbs') -Force
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $dst 'start.vbs') + '"')
Write-Host ''
Write-Host '   [OK] Готово. Программа работает и будет запускаться сама при включении компьютера.' -ForegroundColor Green
Write-Host '     Оплаченные заказы теперь печатаются на кухне автоматически.'
Write-Host ''
Read-Host 'Нажмите Enter, чтобы закрыть'
