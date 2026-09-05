$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoavyStartupWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@

$startupArtifacts = Join-Path (Get-Location) 'src-tauri/target/startup-check'
New-Item -ItemType Directory -Path $startupArtifacts -Force | Out-Null
$startupExecutable = Join-Path (Get-Location) 'src-tauri/target/release/loavy-player.exe'
if (Get-Process -Name loavy-player -ErrorAction SilentlyContinue) {
    throw 'Close the running Loavy app before running the desktop startup test.'
}
$startupApp = Start-Process -FilePath $startupExecutable -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $startupArtifacts 'release-stdout.log') `
    -RedirectStandardError (Join-Path $startupArtifacts 'release-stderr.log')

function Wait-StartupElement([string]$elementName) {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $startupApp.Refresh()
        if ($startupApp.HasExited) {
            throw ('The release app exited during startup. ' + (Get-Content (Join-Path $startupArtifacts 'release-stderr.log') -Raw))
        }
        if ($startupApp.MainWindowHandle -ne 0) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)
            # Enumerating warms WebView2's lazily generated accessibility tree.
            $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($element in $elements) {
                if ($element.Current.Name -eq $elementName) { return $element }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "The release window did not render '$elementName'."
}

function Save-DesktopCapture([string]$name) {
    $null = [LoavyStartupWindow]::SetForegroundWindow($startupApp.MainWindowHandle)
    Start-Sleep -Milliseconds 400
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)
    $rect = $window.Current.BoundingRectangle
    $bitmap = New-Object System.Drawing.Bitmap([int]$rect.Width, [int]$rect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $startupArtifacts $name))
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

try {
    $navigation = Wait-StartupElement 'Downloader'
    $navigation.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'A link. A song. Yours to keep.'
    $songs = Wait-StartupElement 'Songs'
    $songs.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Seconds 1
    $navigation = Wait-StartupElement 'Downloader'
    $navigation.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'A link. A song. Yours to keep.'
    # Allow the persistent downloader's real native startup checks to finish.
    Start-Sleep -Seconds 12
    $startupApp.Refresh()
    if ($startupApp.HasExited -or -not $startupApp.Responding) { throw 'The app did not remain responsive after startup.' }
    $startupErrors = Get-Content (Join-Path $startupArtifacts 'release-stderr.log') -Raw
    if ($startupErrors -match 'overflowed its stack|thread .* panicked') { throw $startupErrors }
    $null = [LoavyStartupWindow]::SetForegroundWindow($startupApp.MainWindowHandle)
    Start-Sleep -Milliseconds 300
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)
    $rect = $window.Current.BoundingRectangle
    $bitmap = New-Object System.Drawing.Bitmap([int]$rect.Width, [int]$rect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $startupArtifacts 'desktop-startup.png'))
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    $playlists = Wait-StartupElement 'Playlists'
    $playlists.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'Every mood. Every moment.'
    $collection = $null
    for ($attempt = 0; $attempt -lt 60 -and -not $collection; $attempt++) {
        $window = [System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $elements) {
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.Name -match '\d+ songs') { $collection = $element; break }
        }
        if (-not $collection) { Start-Sleep -Milliseconds 200 }
    }
    Save-DesktopCapture 'desktop-playlists.png'
    if ($collection) {
        $collection.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $edit = Wait-StartupElement 'Edit playlist'
        Save-DesktopCapture 'desktop-playlist-detail.png'
        $rect = ([System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)).Current.BoundingRectangle
        $null = [LoavyStartupWindow]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
        [LoavyStartupWindow]::mouse_event(0x0080, 0, 0, 1, [UIntPtr]::Zero)
        [LoavyStartupWindow]::mouse_event(0x0100, 0, 0, 1, [UIntPtr]::Zero)
        $null = Wait-StartupElement 'Every mood. Every moment.'
        [LoavyStartupWindow]::mouse_event(0x0080, 0, 0, 2, [UIntPtr]::Zero)
        [LoavyStartupWindow]::mouse_event(0x0100, 0, 0, 2, [UIntPtr]::Zero)
        $edit = Wait-StartupElement 'Edit playlist'
        Write-Output 'Native mouse back/forward buttons navigated between playlist overview and detail.'
        $edit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $null = Wait-StartupElement 'Make it yours'
        Save-DesktopCapture 'desktop-playlist-editor.png'
        $close = Wait-StartupElement 'Close dialog'
        $close.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        foreach ($size in @(@(960,640), @(640,520))) {
            $null = [LoavyStartupWindow]::MoveWindow($startupApp.MainWindowHandle, 20, 20, $size[0], $size[1], $true)
            $null = Wait-StartupElement 'Edit playlist'
            Save-DesktopCapture ('desktop-playlist-' + $size[0] + '.png')
        }
        Write-Output 'Native playlist checks passed: real library cards, detail view, editor, and 960/640-pixel window sizes.'
    }
    $startupApp.Refresh()
    if ($startupApp.HasExited -or -not $startupApp.Responding) { throw 'The app stopped responding during playlist checks.' }
    Write-Output 'Release startup passed: native window, Songs, Downloader and Playlists navigation remained responsive with the existing profile.'
} finally {
    $startupApp.Refresh()
    # Stop only the exact child created by this test, never another Loavy process.
    if (-not $startupApp.HasExited) { $startupApp.Kill(); $startupApp.WaitForExit() }
}
