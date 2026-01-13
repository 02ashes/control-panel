@echo off
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
echo.

if not exist node_modules (
    echo Installing dependencies...
    call npm install
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

