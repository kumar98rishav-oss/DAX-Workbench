@echo off
REM Start the Power BI Desktop bridge (local HTTP API on 127.0.0.1:5177).
REM Builds a self-contained x64 exe on first run (works even with an x86 .NET SDK),
REM then launches it. Open your .pbix in Power BI Desktop, then open the Studio.

setlocal
set HERE=%~dp0
set EXE=%HERE%publish\pbi-desktop-bridge.exe

if not exist "%EXE%" (
  echo Building the bridge ^(first run^)...
  dotnet publish "%HERE%PbiDesktopBridge.csproj" -c Release -r win-x64 --self-contained true -o "%HERE%publish"
)

echo.
echo Power BI Desktop bridge listening on http://127.0.0.1:5177
echo Leave this window open. Open a .pbix in Power BI Desktop, then use the Studio.
echo.
"%EXE%"
