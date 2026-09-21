param([string]$Node, [string]$Repository, [string]$Result)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $Repository
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HiveAcceptanceConsole {
  [DllImport("kernel32.dll")] public static extern bool AllocConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
if ([HiveAcceptanceConsole]::GetConsoleWindow() -eq [IntPtr]::Zero) { [void][HiveAcceptanceConsole]::AllocConsole() }
[void][HiveAcceptanceConsole]::ShowWindow([HiveAcceptanceConsole]::GetConsoleWindow(), 0)
$env:HIVE_TEST_PTY_BACKEND = 'conpty'
$env:PATH = (Split-Path -LiteralPath $Node) + ';' + $env:PATH
& $Node --import tsx tests/manual/windows-conpty-acceptance.ts $Result *> "$Result.log"
exit $LASTEXITCODE
