@echo off
rem Adds the Model Engine graph viewer hooks to your Claude settings (backs it up first). Run uninstall-hooks.js to remove them.
node "%~dp0install-hooks.js" %*
exit /b %errorlevel%
