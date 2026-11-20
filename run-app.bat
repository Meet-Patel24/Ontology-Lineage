@echo off
REM ===========================================================================
REM  Lineage Studio - one-click start (Windows / VM)
REM  Double-click this file. First run installs everything; later runs just
REM  start the backend (http://localhost:8000) and frontend (http://localhost:5173)
REM  in their own windows and open the browser. Use stop-app.bat to stop them.
REM
REM  This file can live in ANY folder (Desktop, a tools folder, ...). It finds the
REM  project folder (the one that contains "backend" and "frontend") like this:
REM    1. a path passed as the first argument:  run-app.bat "D:\Ontology-Lineage"
REM    2. APP_DIR below, if you fill it in
REM    3. the folder this file is in
REM    4. the path remembered in run-app.path.txt (next to this file)
REM    5. otherwise it asks you to pick the folder once and remembers it.
REM  To point it at a different copy later, delete run-app.path.txt.
REM ===========================================================================
setlocal EnableExtensions
title Lineage Studio - launcher

REM Optional: hard-code the project folder here, e.g.  set "APP_DIR=D:\Apps\Ontology-Lineage"
set "APP_DIR="

echo.
echo  ==== Lineage Studio ====
echo.

REM ---- 0. Locate the project folder -----------------------------------------
set "CFG=%~dp0run-app.path.txt"
if not "%~1"=="" set "APP_DIR=%~1"
if defined APP_DIR call :check_dir && goto :dir_found
if defined APP_DIR echo [warn] "%APP_DIR%" is not a Lineage Studio folder.
set "APP_DIR=%~dp0"
call :check_dir && goto :dir_found
if not exist "%CFG%" goto :ask_dir
set "APP_DIR="
set /p APP_DIR=<"%CFG%"
if defined APP_DIR call :check_dir && goto :dir_found
echo [warn] The remembered folder "%APP_DIR%" no longer contains Lineage Studio.

:ask_dir
echo [setup] Where is Lineage Studio? A folder picker will open - choose the folder
echo         that contains "backend" and "frontend".
set "APP_DIR="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select the Lineage Studio folder (contains backend and frontend)'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"`) do set "APP_DIR=%%i"
if not defined APP_DIR set /p "APP_DIR=  Or type / paste the folder path here: "
if not defined APP_DIR goto :no_dir
call :check_dir && goto :dir_found
echo [error] "%APP_DIR%" does not contain backend\app\main.py and frontend\package.json.
goto :ask_dir

:dir_found
>"%CFG%" echo(%APP_DIR%
cd /d "%APP_DIR%"
echo [ok] Project folder: %APP_DIR%

REM ---- 1. Python 3.11+ ------------------------------------------------------
set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :py_found
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if not defined PY goto :no_python
:py_found
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 goto :old_python
echo [ok] Python found (%PY%)

REM ---- 2. Node.js / npm -----------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :no_node
where npm >nul 2>&1
if errorlevel 1 goto :no_node
echo [ok] Node.js found

REM ---- 3. .env with Neo4j credentials ---------------------------------------
if exist ".env" goto :env_ok
echo.
echo [setup] No .env file yet. Creating one from .env.example ...
copy ".env.example" ".env" >nul
echo [setup] Notepad will open. Fill in NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD,
echo         save the file and close Notepad to continue.
echo         (Behind a corporate proxy that inspects TLS, use neo4j+ssc:// in NEO4J_URI.)
notepad ".env"
:env_ok
findstr /c:"NEO4J_PASSWORD=change-me" ".env" >nul
if not errorlevel 1 echo [warn] .env still has the placeholder password - the app will start but cannot reach Neo4j.

REM ---- 4. Backend virtual environment ---------------------------------------
set "VPY=backend\.venv\Scripts\python.exe"
if exist "%VPY%" goto :venv_ok
echo [setup] Creating Python virtual environment ...
%PY% -m venv backend\.venv
if errorlevel 1 goto :fail
:venv_ok
REM Reinstall only when requirements.txt changed since the last install.
fc /b "backend\requirements.txt" "backend\.venv\.installed-requirements" >nul 2>&1
if not errorlevel 1 goto :pip_ok
echo [setup] Installing backend packages (first run takes a minute) ...
"%VPY%" -m pip install --disable-pip-version-check -q --upgrade pip
"%VPY%" -m pip install --disable-pip-version-check -r backend\requirements.txt
if errorlevel 1 goto :fail
copy /y "backend\requirements.txt" "backend\.venv\.installed-requirements" >nul
:pip_ok
echo [ok] Backend packages ready

REM ---- 5. Frontend packages -------------------------------------------------
fc /b "frontend\package-lock.json" "frontend\node_modules\.installed-lock" >nul 2>&1
if not errorlevel 1 goto :npm_ok
echo [setup] Installing frontend packages (first run takes a few minutes) ...
pushd frontend
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  goto :fail
)
popd
copy /y "frontend\package-lock.json" "frontend\node_modules\.installed-lock" >nul
:npm_ok
echo [ok] Frontend packages ready

REM ---- 6. Start backend -----------------------------------------------------
netstat -ano | findstr ":8000 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [info] Something is already listening on port 8000 - assuming the backend is running.
  goto :backend_started
)
echo [run] Starting backend on http://localhost:8000 ...
start "Lineage Studio API" cmd /k "cd /d "%APP_DIR%\backend" && .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
:backend_started

REM ---- 7. Start frontend ----------------------------------------------------
netstat -ano | findstr ":5173 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [info] Something is already listening on port 5173 - assuming the frontend is running.
  goto :frontend_started
)
echo [run] Starting frontend on http://localhost:5173 ...
start "Lineage Studio UI" cmd /k "cd /d "%APP_DIR%\frontend" && npm run dev -- --host 0.0.0.0 --port 5173 --strictPort"
:frontend_started

REM ---- 8. Wait until both answer, then open the browser ---------------------
echo [wait] Waiting for the servers to come up ...
set /a TRIES=0
:wait_loop
set /a TRIES+=1
if %TRIES% gtr 90 goto :slow
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://127.0.0.1:8000/api/health
if errorlevel 1 goto :wait_loop
curl -s -o nul http://127.0.0.1:5173/
if errorlevel 1 goto :wait_loop

echo.
echo  Lineage Studio is running:
echo    App       http://localhost:5173
echo    API docs  http://localhost:8000/docs
echo  From another machine use this VM's IP address instead of localhost
echo  (allow ports 5173/8000 in the VM firewall if needed).
echo  Close the two server windows, or run stop-app.bat, to stop.
echo.
start "" "http://localhost:5173"
ping -n 6 127.0.0.1 >nul
exit /b 0

:slow
echo [warn] Servers did not answer within 90 seconds. Check the
echo        "Lineage Studio API" and "Lineage Studio UI" windows for errors.
pause
exit /b 1

:check_dir
REM Normalise APP_DIR (strip quotes and a trailing backslash) and check it is the project.
set "APP_DIR=%APP_DIR:"=%"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if not exist "%APP_DIR%\backend\app\main.py" exit /b 1
if not exist "%APP_DIR%\frontend\package.json" exit /b 1
exit /b 0

:no_dir
echo [error] No project folder chosen. Run this file again and pick the folder
echo         that contains "backend" and "frontend".
pause
exit /b 1

:no_python
echo [error] Python 3.11+ was not found. Install it from https://www.python.org/downloads/
echo         (tick "Add python.exe to PATH"), then run this file again.
pause
exit /b 1

:old_python
echo [error] Python 3.11 or newer is required. Found:
%PY% --version
pause
exit /b 1

:no_node
echo [error] Node.js 20+ was not found. Install the LTS version from https://nodejs.org/
echo         then run this file again.
pause
exit /b 1

:fail
echo.
echo [error] Setup failed - see the messages above.
echo         On a VM behind a proxy, set HTTP_PROXY / HTTPS_PROXY (pip) and
echo         "npm config set proxy ..." (npm) and try again.
pause
exit /b 1
