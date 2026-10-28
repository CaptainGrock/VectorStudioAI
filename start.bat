@echo off
setlocal EnableExtensions
title VectorStudio AI
cd /d "%~dp0"
set "LOG=%~dp0launcher.log"
echo [%date% %time%] === VectorStudio launcher started ===> "%LOG%"
echo [VectorStudio] Looking for Node.js ... (full log: launcher.log)

where node >nul 2>nul
if not errorlevel 1 goto havennode
echo [VectorStudio] not on PATH, checking usual install spots ...
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto havennode
if exist "C:\pinokio\bin\miniforge\node.exe" set "PATH=C:\pinokio\bin\miniforge;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto havennode

echo [VectorStudio] Node.js was not found on this machine. >> "%LOG%"
echo [VectorStudio] Node.js was not found on this machine.
echo.
choice /M "Install Node.js 20 LTS now with winget"
if errorlevel 2 goto noinstall
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
if errorlevel 1 goto wingetfail
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto needrelogin
goto havennode

:wingetfail
echo [VectorStudio] Automatic install failed. Install Node.js 20 LTS from https://nodejs.org/ manually,
echo then double-click start.bat again.
echo [VectorStudio] winget install failed. >> "%LOG%"
pause
exit /b 1

:needrelogin
echo [VectorStudio] Installed, but node is not on PATH yet. Close this window,
echo log out and back in (or reboot), then double-click start.bat again.
echo [VectorStudio] installed but not on PATH; relogin needed. >> "%LOG%"
pause
exit /b 1

:noinstall
echo [VectorStudio] OK - install Node.js 20 LTS from https://nodejs.org/ when ready,
echo then double-click start.bat again.
pause
exit /b 1

:havennode
for /f "tokens=*" %%v in ('node --version') do set NODEV=%%v
echo [VectorStudio] Using %NODEV%  (npm: checking...)
echo [VectorStudio] Using %NODEV%>> "%LOG%"
where npm >nul 2>nul
if errorlevel 1 goto nonpm
for /f "tokens=*" %%v in ('npm --version') do echo [VectorStudio] npm %%v
for /f "tokens=*" %%v in ('npm --version') do echo [VectorStudio] npm %%v>> "%LOG%"

set PKGHASH=unknown
for /f "tokens=*" %%h in ('certutil -hashfile package.json SHA256 ^| find /v ":" ^| find /v "CertUtil"') do set PKGHASH=%%h
set OLDHASH=none
if exist "node_modules\.vs-deps-hash" set /p OLDHASH=<"node_modules\.vs-deps-hash"
if not exist "node_modules" goto firstinstall
if "%PKGHASH%"=="%OLDHASH%" goto pickport
echo [VectorStudio] Dependencies changed - updating (progress below) ...
goto doinstall

:firstinstall
echo [VectorStudio] First run - installing dependencies (a few minutes, progress below) ...
:doinstall
echo [VectorStudio] npm install started. >> "%LOG%"
call npm install
if errorlevel 1 goto installfail
echo %PKGHASH%> "node_modules\.vs-deps-hash"
echo [VectorStudio] Dependencies installed. >> "%LOG%"
goto pickport

:installfail
echo [VectorStudio] npm install FAILED - see errors above. They are also saved in launcher.log.
call npm install >> "%LOG%" 2>&1
pause
exit /b 1

:nonpm
echo [VectorStudio] ERROR: node found but npm is missing. Reinstall Node.js from https://nodejs.org/
echo [VectorStudio] node without npm. >> "%LOG%"
pause
exit /b 1

:pickport
set PORT=5173
netstat -ano | findstr /c:":5173 " | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 set PORT=5174
netstat -ano | findstr /c:":5174 " | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 set PORT=5175
echo [VectorStudio] Port: %PORT%>> "%LOG%"

echo [VectorStudio] Starting local-engine backend + studio at http://127.0.0.1:%PORT%/ ...
echo [VectorStudio] The browser opens in a few seconds. Keep this window open; close it (or Ctrl+C) to stop.
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
call npm run dev -- --port %PORT% --host 127.0.0.1
echo.
echo [VectorStudio] Server stopped (exit code %errorlevel%). See launcher.log if this was unexpected.
pause
