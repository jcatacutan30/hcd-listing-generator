@echo off
title HCD Listing Generator
cd /d "%~dp0"
echo.
echo  ============================================
echo   HCD Listing Generator
echo   Starting server...
echo  ============================================
echo.
node server.js
echo.
echo  Server stopped. Press any key to exit.
pause >nul
