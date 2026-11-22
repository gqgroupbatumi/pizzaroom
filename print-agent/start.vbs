' Pizza Room - zapusk pechati na kuhnyu bez okna
Set sh = CreateObject("WScript.Shell")
p = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\PizzaRoomPrint\agent.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & p & """", 0, False
