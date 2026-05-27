@echo off
echo.
echo  ============================================
echo    IPL Trump Card Arena - Multiplayer Server
echo  ============================================
echo.
echo  Starting backend on http://localhost:3000 ...
echo.
echo  Players on the same WiFi can join at:
echo  http://[YOUR_IP]:3000/gemini-code-game.html
echo.
echo  Press Ctrl+C to stop the server.
echo.
cd /d "%~dp0"
node server.js
pause
