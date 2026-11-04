@echo off
rem Removes the scheduled Claude token sync tasks. A missing task is not an error.
schtasks /Delete /TN "ModelEngineClaudeTokenSync" /F >nul 2>&1
schtasks /Delete /TN "ModelEngineClaudeTokenSyncLogon" /F >nul 2>&1
exit /b 0
