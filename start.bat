@echo off
setlocal
cd /d "%~dp0"
title CoraByte Payroll

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install it with:  winget install OpenJS.NodeJS.LTS
  echo then open a NEW window and run start.bat again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22.13 or newer is required. Update with:  winget upgrade OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

set PORT_TO_OPEN=8080
if exist .env for /f "tokens=1,2 delims==" %%a in ('findstr /b "PORT=" .env') do set PORT_TO_OPEN=%%b

start "" "http://localhost:%PORT_TO_OPEN%/"
node --disable-warning=ExperimentalWarning src\server.js
pause
