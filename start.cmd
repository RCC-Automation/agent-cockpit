@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First start: installing, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo Install failed. See the messages above.
    pause
    exit /b 1
  )
)
node server.mjs --open
pause
