@echo off
REM ============================================================
REM  CLEAR TO AIR - start the local agent and open the control room
REM  Leave this window open while you are on air.
REM ============================================================
title CLEAR TO AIR AGENT - LEAVE OPEN
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not on PATH. Install Node 22 or newer, then run this again.
  pause
  exit /b 1
)
if not exist "agent\node_modules" (
  echo   [setup] installing dependencies - first run only...
  call npm run setup
)
if not exist "web\dist\index.html" (
  echo   [setup] building the control room - first run only...
  call npm run build
)
echo   [1/2] starting the agent on http://127.0.0.1:7700 ...
start "CLEAR TO AIR AGENT - LEAVE OPEN" /min cmd /c "node agent\src\index.js ^& pause"
set /a tries=0
:waitsrv
set /a tries+=1
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:7700/healthz) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto up
if %tries% GEQ 20 ( echo   agent did not answer after 20 s - check the agent window. & pause & exit /b 1 )
timeout /t 1 /nobreak >nul
goto waitsrv
:up
echo   [2/2] opening the control room...
start "" http://127.0.0.1:7700/
echo.
echo   Control room:  http://127.0.0.1:7700/
echo   Overlays:      http://127.0.0.1:7700/packs/^<game^>/overlay/ingame.html  - add as OBS browser sources, or install the generated collection from Setup
echo.
pause
