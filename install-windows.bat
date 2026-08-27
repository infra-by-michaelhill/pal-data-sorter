@echo off
REM PAL Data Sorter - Windows installer.
REM Double-click this file. It finds Python 3 (installing it via winget if
REM needed), then puts a "PAL Data Sorter" shortcut on your Desktop that starts
REM the app and opens it in your browser.

setlocal enabledelayedexpansion
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

echo ======================================================
echo   PAL Data Sorter - setup
echo ======================================================
echo.

REM --- locate a Python 3 launcher ---------------------------------------
set "PYCMD="
where py >nul 2>&1 && (py -3 -c "import sys" >nul 2>&1 && set "PYCMD=py -3")
if not defined PYCMD (
  where python >nul 2>&1 && (python -c "import sys; exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1 && set "PYCMD=python")
)

if not defined PYCMD (
  echo Python 3 was not found. Attempting to install it with winget...
  where winget >nul 2>&1
  if !errorlevel! equ 0 (
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    echo.
    echo If the install succeeded, please CLOSE this window and double-click
    echo install-windows.bat again so it can find the new Python.
    echo.
    pause
    exit /b 0
  ) else (
    echo Could not find winget either. Please install Python 3 from:
    echo     https://www.python.org/downloads/windows/
    echo IMPORTANT: on the first installer screen, check "Add Python to PATH".
    echo Then double-click install-windows.bat again.
    start "" "https://www.python.org/downloads/windows/"
    pause
    exit /b 1
  )
)
echo Found Python: %PYCMD%

REM --- create a launcher batch file in the app folder -------------------
set "LAUNCHER=%APP_DIR%\run-windows.bat"
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo cd /d "%APP_DIR%"
>> "%LAUNCHER%" echo echo Starting PAL Data Sorter - a browser tab will open shortly.
>> "%LAUNCHER%" echo echo Keep this window open while you use the app; close it to quit.
>> "%LAUNCHER%" echo %PYCMD% serve.py --open

REM --- drop a Desktop shortcut pointing at the launcher -----------------
set "SHORTCUT=%USERPROFILE%\Desktop\PAL Data Sorter.lnk"
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%LAUNCHER%';" ^
  "$s.WorkingDirectory='%APP_DIR%';" ^
  "$s.IconLocation='%SystemRoot%\System32\shell32.dll,13';" ^
  "$s.Description='Launch PAL Data Sorter';" ^
  "$s.Save()"

echo.
echo Done. A "PAL Data Sorter" shortcut is on your Desktop.
echo Double-click it whenever you want to open the app.
echo.
echo Launching it now...
start "" "%LAUNCHER%"
exit /b 0
