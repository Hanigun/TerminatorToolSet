@echo off
rem Build TerminatorSheetQt.exe (PySide6 + QtWebEngine, onefile, windowed)
cd /d "%~dp0"
python -m PyInstaller --noconfirm --clean TerminatorSheet.spec
echo.
echo Done. Artifact: %cd%\dist\TerminatorSheetQt.exe
pause
