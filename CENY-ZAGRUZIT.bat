@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Загружаю реальные цены и комиссии в базу Pizza Room...
echo На вопрос "Ok to proceed?" нажмите y и Enter.
call npx --yes wrangler@4 d1 execute pizzaroom --remote --file=update-prices.sql
echo.
echo Готово. Сфотографируйте экран, если есть слово ERROR.
pause
