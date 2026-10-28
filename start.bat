@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing packages...
  call npm install
)
node server.js --open
pause
