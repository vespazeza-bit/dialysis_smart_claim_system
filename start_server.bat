@echo off
cd /d "%~dp0dialysis_smart_claim_system"

echo Starting DMIS Proxy on port 8765...
start "DMIS Proxy" cmd /k "node proxy.js"

echo Starting Web Server on port 3000...
start "DMIS Web" cmd /k "npx serve --listen 3000 ."

echo.
echo Servers starting...
echo   Proxy  : http://localhost:8765
echo   Web    : http://localhost:3000
echo.
timeout /t 2 >nul
start "" "http://localhost:3000"
