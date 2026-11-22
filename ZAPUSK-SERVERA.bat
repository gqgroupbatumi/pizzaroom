@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pizza Room - запуск сервера
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Сначала установите Node.js: https://nodejs.org  ^(кнопка LTS^), затем запустите этот файл снова.
  start https://nodejs.org
  pause
  exit /b
)
node scripts\setup.mjs
echo.
pause
