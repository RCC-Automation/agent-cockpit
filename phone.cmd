@echo off
cd /d "%~dp0"
rem Opens the cockpit to your iPhone through Tailscale (on), closes it (off), or shows the address (status).
node phone.mjs %*
if "%~1"=="" pause
