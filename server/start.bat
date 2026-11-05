@echo off
cd /d %~dp0
set SERVE_CLIENT=true
start http://localhost:3000
npm run dev
