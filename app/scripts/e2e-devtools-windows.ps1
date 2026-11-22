# Native Windows check of the browser accelerators:
# starts the debug app, brings its window to the front, sends REAL key presses (keybd_event, not the
# DevTools protocol, which would skip the accelerators of the browser process) with the scan code of a real
# keyboard (without it the page sees an empty KeyboardEvent.code and Tauri's own Ctrl+Shift+I listener, the
# cause of, never fires) and looks for a DevTools
# window. Ctrl+Shift+I, Ctrl+Shift+J and F12 must open none. With -DeveloperSwitch the app is started with
# EQUAVELA_DEVTOOLS=1 and must open the developer tools at startup (debug build only).
# Usage: powershell -File app/scripts/e2e-devtools-windows.ps1 -Exe target/debug/equavela-app.exe [-DeveloperSwitch]
# The keys are only sent while the app window is the foreground window; otherwise the run aborts.
# Exit code = number of failed checks.
param([Parameter(Mandatory = $true)][string]$Exe, [switch]$DeveloperSwitch)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class W {
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> Titles() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.Length > 0) r.Add(s.ToString()); } return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$failed = 0
function Check($name, $ok, $detail = "") {
  if (-not $ok) { $script:failed++ }
  Write-Host ("{0}  {1}  {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail)
}
function DevToolsWindows { @([W]::Titles() | Where-Object { $_ -match "DevTools" }) }

$data = Join-Path $env:TEMP ("mm-devtools-" + [guid]::NewGuid())
New-Item -ItemType Directory $data | Out-Null
$env:EQUAVELA_MULTI_INSTANCE = "1"
$env:EQUAVELA_DRIVER_DATA_DIR = $data
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $data "wv"
if ($DeveloperSwitch) { $env:EQUAVELA_DEVTOOLS = "1" } else { Remove-Item Env:EQUAVELA_DEVTOOLS -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath $Exe -PassThru
try {
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh(); $hwnd = $p.MainWindowHandle }
  Start-Sleep -Seconds 8
  if ($DeveloperSwitch) {
    Check "EQUAVELA_DEVTOOLS opens the developer tools in a debug build" ((DevToolsWindows).Count -gt 0) ((DevToolsWindows) -join "; ")
  } else {
    $vk = @{ ctrl = 0x11; shift = 0x10; i = 0x49; j = 0x4A; f12 = 0x7B }
    foreach ($keys in @("ctrl+shift+i", "ctrl+shift+j", "f12")) {
      [void][W]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 800
      if ([W]::GetForegroundWindow() -ne $hwnd) { Write-Host "ABORT: the app window is not in the foreground; no key was sent"; $failed++; break }
      $parts = $keys.Split("+")
      foreach ($k in $parts) { [W]::keybd_event([byte]$vk[$k], [byte][W]::MapVirtualKey($vk[$k], 0), 0, [UIntPtr]::Zero) }
      Start-Sleep -Milliseconds 100
      [array]::Reverse($parts)
      foreach ($k in $parts) { [W]::keybd_event([byte]$vk[$k], [byte][W]::MapVirtualKey($vk[$k], 0), 2, [UIntPtr]::Zero) }
      Start-Sleep -Seconds 3
      Check "$keys opens no developer tools" ((DevToolsWindows).Count -eq 0) ((DevToolsWindows) -join "; ")
    }
  }
} finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
exit $failed
