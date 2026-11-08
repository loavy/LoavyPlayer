@echo off
rem Builds the Windows installer and copies it to a Downloads folder.
rem Usage: build-installer.cmd [destination folder]
rem Default destination: %USERPROFILE%\Downloads\Loavy Player
setlocal
cd /d "%~dp0"

rem Use cargo from PATH, or from a rustup install in a few common places.
if exist "%LOCALAPPDATA%\LoavyBuildTools\cargo\bin\cargo.exe" (
  set "RUSTUP_HOME=%LOCALAPPDATA%\LoavyBuildTools\rustup"
  set "CARGO_HOME=%LOCALAPPDATA%\LoavyBuildTools\cargo"
  set "PATH=%LOCALAPPDATA%\LoavyBuildTools\cargo\bin;%PATH%"
)
if exist "%LOCALAPPDATA%\LoavyBuildTools\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
  set "RUSTUP_HOME=%LOCALAPPDATA%\LoavyBuildTools\rustup"
  set "PATH=%LOCALAPPDATA%\LoavyBuildTools\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSION=%%v"
if not defined VERSION (
  echo Could not read the version from package.json. Is Node.js installed?
  pause
  exit /b 1
)

set "DEST=%~1"
if not defined DEST set "DEST=%USERPROFILE%\Downloads\Loavy Player"
set "LOG=%~dp0src-tauri\target\installer-build.log"
set "STATUS=%~dp0src-tauri\target\installer-build.status"
set "SETUP=src-tauri\target\release\bundle\nsis\Loavy Player_%VERSION%_x64-setup.exe"
set "OUT=Loavy-Player-%VERSION%-Windows-x64-Setup.exe"

if not exist "%~dp0src-tauri\target" mkdir "%~dp0src-tauri\target"
echo RUNNING> "%STATUS%"
echo Building Loavy Player %VERSION%. This usually takes a few minutes...
echo Progress is written to %LOG%
(where cargo & where node & cargo --version) > "%LOG%" 2>&1
call npm run desktop:build >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: build>> "%LOG%"
  echo FAILED> "%STATUS%"
  echo Build failed. See %LOG%
  pause
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SETUP%" "%DEST%\%OUT%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo FAILED: copy>> "%LOG%"
  echo FAILED> "%STATUS%"
  echo Copy failed. See %LOG%
  pause
  exit /b 1
)
dir "%DEST%" >> "%LOG%"
echo DONE> "%STATUS%"
echo.
echo Installer ready: %DEST%\%OUT%
timeout /t 8
