@echo off
REM Start the Power BI Desktop bridge (local HTTP API on 127.0.0.1:5177).
REM
REM This is the DEVELOPER path — build from source, then run. End users need
REM neither this nor the .NET SDK: they download the prebuilt bridge from the
REM Studio's front page and double-click it (it is self-contained).
REM
REM Builds a single self-contained x64 exe on first run (works even with an x86
REM .NET SDK, which cannot "dotnet run" an x64 app). Pass -rebuild after changing
REM any source — otherwise an existing publish\ folder is reused as-is.

setlocal
set HERE=%~dp0
set EXE=%HERE%publish\pbi-desktop-bridge.exe

if /I "%~1"=="-rebuild" (
  echo Rebuilding from source...
  if exist "%HERE%publish" rmdir /s /q "%HERE%publish"
)

if not exist "%EXE%" (
  echo Building the bridge ^(takes a minute^)...
  dotnet publish "%HERE%PbiDesktopBridge.csproj" -c Release -r win-x64 --self-contained true ^
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o "%HERE%publish"
  if errorlevel 1 (
    echo.
    echo Build failed. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0
    exit /b 1
  )
)

echo.
echo Power BI Desktop bridge listening on http://127.0.0.1:5177
echo Leave this window open. Open a .pbix in Power BI Desktop, then use the Studio.
echo.
"%EXE%"
