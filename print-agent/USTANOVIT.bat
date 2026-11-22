@echo off
chcp 65001 >nul
title Pizza Room - pechat na kuhnyu
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
