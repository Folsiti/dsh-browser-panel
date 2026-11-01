# Captures the browser window the plugin opened, for the verification record.
#
# Runs while `node e2e/browser.mjs --visible --hold ...` is up. It finds the
# plugin's own browser by its profile directory, forces the window to the front
# (SetForegroundWindow is refused to a background caller), and crops the screen
# to the window rectangle, so the shot contains the browser and nothing else.
#
#   pwsh -File e2e/capture-window.ps1                 -> e2e/window-demo.png
#   pwsh -File e2e/capture-window.ps1 -Out other.png  -> e2e/other.png
param([string]$Out = 'window-demo.png')

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCapture {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@

Start-Sleep -Seconds 8

$target = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-browser-panel-e2e-*' } |
  Select-Object -First 1
if (-not $target) { Write-Output 'no plugin browser process found'; exit 1 }

$process = Get-Process -Id $target.ProcessId
$handle = $process.MainWindowHandle
Write-Output "pid=$($target.ProcessId) hwnd=$handle title='$($process.MainWindowTitle)'"
if ($handle -eq [IntPtr]::Zero) { Write-Output 'the process has no visible main window'; exit 1 }

# Force it on top: SetForegroundWindow is refused to a background caller.
[WinCapture]::ShowWindow($handle, 9) | Out-Null
[WinCapture]::SetWindowPos($handle, [IntPtr](-1), 40, 40, 1120, 760, 0x0040) | Out-Null
Start-Sleep -Milliseconds 1500

# The window sits at 40,40 with an 1120x760 outer size; the crop keeps a hair of
# margin for the border and leaves the rest of the desktop out of the file.
$box = New-Object System.Drawing.Rectangle(48, 40, 1100, 752)
$bitmap = New-Object System.Drawing.Bitmap($box.Width, $box.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($box.X, $box.Y, 0, 0, $bitmap.Size)
$path = Join-Path $PSScriptRoot $Out
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "wrote $path"
