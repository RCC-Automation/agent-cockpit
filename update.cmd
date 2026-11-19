@echo off
rem Stops the cockpit, gets the newest version and starts it again.
cd /d "%~dp0"
node server.mjs --stop
git pull
if errorlevel 1 (
  echo.
  echo  The update did not work. See the message above. Starting the version you have.
)
call npm install --no-audit --no-fund >nul 2>nul
call "%~dp0start.cmd"
