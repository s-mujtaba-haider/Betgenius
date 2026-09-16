@echo off
setlocal

set REPO=C:\Users\Admin\Projects\Betting\betgenius
set CERT=%REPO%\prod-ca-2021.crt
set ENVFILE=%REPO%\harness\.env

echo === batter_hits full backtest ===

REM Guard: refuse to start if another deno run is already scoring
tasklist /fi "imagename eq deno.exe" 2>nul | find /i "deno.exe" >nul
if not errorlevel 1 (
  echo.
  echo ABORTED: a deno process is already running.
  echo Connection limit is 10 and two backtests must not run at once.
  echo Let the existing run finish, or kill it deliberately first.
  goto :end
)

if not exist "%CERT%" (
  echo ABORTED: cert not found at %CERT%
  goto :end
)

if not exist "%ENVFILE%" (
  echo ABORTED: harness\.env not found. Deno needs HARNESS_DATABASE_URL.
  goto :end
)

cd /d "%REPO%"
set DENO_CERT=%CERT%

echo Repo:  %REPO%
echo Cert:  set (value not printed)
echo Env:   found (value not printed)
echo Start: %DATE% %TIME%
echo.
echo Full 3-year window. 440956 candidates at roughly 3/sec.
echo Expect 1.5 to 2 days. Do not close this window or sleep the machine.
echo.

deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=batter_hits

echo.
echo Finished: %DATE% %TIME%
echo Output should be in harness\out\batter_hits_*.json
dir /b "%REPO%\harness\out\batter_hits_*.json"

:end
endlocal
pause
