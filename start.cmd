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
rem The cockpit runs in the background without a window, so closing a window never stops it.
powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList 'server.mjs','--open' -WindowStyle Hidden"
node server.mjs --wait
if errorlevel 1 (
  echo.
  echo  The cockpit did not start. Look at data\cockpit.log for the reason.
  pause
  exit /b 1
)
echo.
echo  It runs in the background. Closing this window or the browser stops nothing.
echo  To stop the cockpit: Shut down in the page, or stop.cmd.
echo  Agents in PowerShell windows keep running either way.
echo.
timeout /t 8 >nul
