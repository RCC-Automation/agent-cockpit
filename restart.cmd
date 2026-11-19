@echo off
rem Stops the cockpit and starts it again. Agents in PowerShell windows keep running.
cd /d "%~dp0"
node server.mjs --stop
call "%~dp0start.cmd"
