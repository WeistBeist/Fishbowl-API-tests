@echo off
setlocal
cd /d "%~dp0"
title Fishbowl Query Report
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo Leave this window open while you use the report.
echo Opening http://127.0.0.1:8787/
start "" "http://127.0.0.1:8787/"
node server.js
if errorlevel 1 pause
