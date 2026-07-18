@echo off
REM One command -> one exe: builds the Studio frontend, embeds it in the
REM bridge, publishes a single self-contained tray app.
setlocal
set HERE=%~dp0

pushd "%HERE%..\.."
call npm run build
if errorlevel 1 ( popd & echo FRONTEND BUILD FAILED & exit /b 1 )
popd

REM /MIR mirrors; the download folder (the exe itself!) and local fixtures stay out.
robocopy "%HERE%..\..\dist" "%HERE%wwwroot" /MIR /XD download /XF choco.xlsx *.pbix >nul
if %errorlevel% GEQ 8 ( echo COPY FAILED & exit /b 1 )

dotnet publish "%HERE%PbiDesktopBridge.csproj" -c Release -r win-x64 --self-contained true ^
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o "%HERE%publish"
if errorlevel 1 ( echo PUBLISH FAILED & exit /b 1 )

echo.
echo Done: %HERE%publish\pbi-desktop-bridge.exe  (UI + API + tray, one file)
