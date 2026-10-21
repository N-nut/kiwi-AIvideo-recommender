@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\start.mjs" %*
set "kiwiExitCode=%errorlevel%"
if not "%kiwiExitCode%"=="0" pause
exit /b %kiwiExitCode%
