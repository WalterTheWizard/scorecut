@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Scorecut.ps1"
if errorlevel 1 (
  echo.
  echo Scorecut setup did not finish. Review the error above.
  pause
)
