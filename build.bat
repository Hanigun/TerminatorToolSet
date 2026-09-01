@echo off
rem Build TerminatorSheet.exe (onefile, windowed)
cd /d "%~dp0"
python -m PyInstaller --noconfirm --clean TerminatorSheet.spec
echo.
echo Done. Artifact: %cd%\dist\TerminatorSheet.exe
pause
