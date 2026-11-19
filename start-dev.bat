@echo off
REM Lineage Studio - local development (Windows)
REM Starts the FastAPI backend on :8000 and the Vite dev server on :5173.
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [setup] No .env found - copying .env.example. Edit it with your Neo4j credentials.
  copy ".env.example" ".env" >nul
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo [setup] Creating Python virtual environment...
  python -m venv backend\.venv || goto :error
  backend\.venv\Scripts\python -m pip install --upgrade pip >nul
  backend\.venv\Scripts\pip install -r backend\requirements-dev.txt || goto :error
)

if not exist "frontend\node_modules" (
  echo [setup] Installing frontend packages...
  pushd frontend
  call npm install || (popd & goto :error)
  popd
)

echo Starting backend on http://localhost:8000 ...
start "Lineage Studio API" cmd /k "cd /d %~dp0backend && .venv\Scripts\python -m uvicorn app.main:app --reload --port 8000"

echo Starting frontend on http://localhost:5173 ...
start "Lineage Studio UI" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Open http://localhost:5173  (API docs: http://localhost:8000/docs)
exit /b 0

:error
echo Setup failed. See the messages above.
exit /b 1
