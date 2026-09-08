@echo off
cd /d "%~dp0"
echo ======================================
echo   Lovense Control Panel - START
echo ======================================
echo.

echo Checking Node.js installation...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not installed!
    echo Please download and install Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node.js found!
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>24||(major===24&&minor>=15)?0:1)"
if %errorlevel% neq 0 (
    echo ERROR: Node.js 24.15 or newer is required. Use the Node.js 24 LTS release.
    pause
    exit /b 1
)
echo.

if not exist node_modules (
    echo Installing dependencies...
    call npm ci
    if errorlevel 1 exit /b 1
    echo.
)

echo Starting server...
echo.
echo ======================================
echo   Server will start at:
echo   http://localhost:3000
echo ======================================
echo.
echo Press Ctrl+C to stop the server
echo.

call npm start
