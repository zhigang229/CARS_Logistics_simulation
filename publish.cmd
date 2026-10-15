@echo off
rem One-click publish to the IIS server. Usage: publish.cmd [-DryRun] [-Rollback] [-SkipTests]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\publish.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if "%LOGISIM_NO_PAUSE%"=="" pause
exit /b %EXITCODE%
