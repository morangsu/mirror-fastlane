@echo off
setlocal
rem mirror-fastlane: write/read the GitHub token used by hash-hook.ps1
rem Works from both CMD and PowerShell, no environment variable expansion needed.
rem Can be launched from ANY folder (Downloads, USB, temp): the credential path is
rem resolved from the hash-hook.ps1 that IDM actually invokes.
rem Running with no arguments prompts for the PAT and then runs every remaining step.
rem Examples:
rem   set-hook-token.cmd                 interactive PAT, then write + verify (recommended)
rem   set-hook-token.cmd -FromClipboard  read token from clipboard, then write + verify
rem   set-hook-token.cmd -NoVerify      skip the online GitHub API check
rem   set-hook-token.cmd -Show           show resolved paths and status only
rem   set-hook-token.cmd -Remove         delete credential file
rem This .cmd must sit next to set-hook-token.ps1; the .ps1 alone also works.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-hook-token.ps1" %*
set "rc=%ERRORLEVEL%"
if "%~1"=="" (
  echo.
  echo Press any key to close...
  pause >nul
)
exit /b %rc%
