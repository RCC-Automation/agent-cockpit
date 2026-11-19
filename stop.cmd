@echo off
cd /d "%~dp0"
node server.mjs --stop
timeout /t 5 >nul
