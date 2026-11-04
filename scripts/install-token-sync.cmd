@echo off
rem Schedules the Claude token sync for this Windows user: every 2 hours (and at logon if an admin prompt allows it), and runs it once now.
setlocal
set "TASK=ModelEngineClaudeTokenSync"
set "SCRIPT=%~dp0sync-claude-token.js"
schtasks /Create /SC HOURLY /MO 2 /TN "%TASK%" /TR "node \"%SCRIPT%\" --quiet --refresh" /F
if errorlevel 1 exit /b 1
schtasks /Run /TN "%TASK%"
schtasks /Create /SC ONLOGON /TN "%TASK%Logon" /TR "node \"%SCRIPT%\" --quiet --refresh" /F >nul 2>&1
if errorlevel 1 echo Logon task skipped (needs an administrator prompt). The 2-hourly task still keeps the token fresh.
exit /b 0
