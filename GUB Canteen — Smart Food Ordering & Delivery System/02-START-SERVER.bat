@echo off
cd /d "%~dp0"
echo ----------------------------------------------
echo GUB Canteen - Student site + Owner Dashboard
 echo ----------------------------------------------
echo Student website:  http://127.0.0.1:8000
 echo Owner dashboard:  http://127.0.0.1:8000/admin.html
 echo Close this window to stop your server.
echo.
where py >nul 2>&1
if %errorlevel%==0 (
  py server.py
) else (
  python server.py
)
echo.
pause
