@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist ".claude\live\node_modules" (
  echo First run: installing dependencies from npm...
  call npm ci --omit=dev --ignore-scripts --prefix .claude/live
  if errorlevel 1 (
    echo npm install failed. Check your connection then run this again.
    pause
    exit /b 1
  )
)
rem Keep exit on this line: an update can replace this file while it runs.
node ".claude\live\server.js" --open & exit /b
