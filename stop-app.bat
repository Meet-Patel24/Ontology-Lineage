@echo off
REM Lineage Studio - stop the backend and frontend started by run-app.bat
echo Stopping Lineage Studio ...
taskkill /fi "WINDOWTITLE eq Lineage Studio API*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq Lineage Studio UI*" /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000 " ^| findstr LISTENING') do taskkill /pid %%p /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173 " ^| findstr LISTENING') do taskkill /pid %%p /t /f >nul 2>&1
echo Done.
ping -n 3 127.0.0.1 >nul
