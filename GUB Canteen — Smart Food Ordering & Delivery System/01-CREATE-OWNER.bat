@echo off
cd /d "%~dp0"
echo ----------------------------------------------
echo GUB Canteen - First-time OWNER setup
 echo ----------------------------------------------
echo Choose a NEW password, not your university password.
echo.
where py >nul 2>&1
if %errorlevel%==0 (
  py server.py --create-owner
) else (
  python server.py --create-owner
)
echo.
pause
