Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*PizzaRoomPrint*agent.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'PizzaRoom-Pechat-Kuhnya.vbs') -ErrorAction SilentlyContinue
Write-Host 'Pechat na kuhnyu otklyuchena.'
