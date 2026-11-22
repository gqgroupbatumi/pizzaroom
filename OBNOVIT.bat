@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pizza Room - обновление
echo Выкладываю обновлённую версию...
npx --yes wrangler@4 deploy
echo.
pause
