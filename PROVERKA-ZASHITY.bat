@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pizza Room - проверка защиты
node --no-warnings test\run.mjs
echo.
pause
