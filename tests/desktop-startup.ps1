$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoavyStartupWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@

$startupArtifacts = Join-Path (Get-Location) 'src-tauri/target/startup-check'
New-Item -ItemType Directory -Path $startupArtifacts -Force | Out-Null
$startupExecutable = Join-Path (Get-Location) 'src-tauri/target/release/loavy-player.exe'
$isolatedCheck = $false
if ($env:LOAVY_DESKTOP_TEST_EXE) {
    $startupExecutable = (Resolve-Path -LiteralPath $env:LOAVY_DESKTOP_TEST_EXE).Path
    $validationDirectory = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) 'src-tauri/target/spotify-validation')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $startupExecutable.StartsWith($validationDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The alternate test executable must be in the isolated validation directory.' }
    $validationConfig = Get-Content -LiteralPath (Join-Path (Get-Location) 'src-tauri/target/spotify-native-config.json') -Raw | ConvertFrom-Json
    if ($validationConfig.identifier -ne 'com.loavy.player.spotifyvalidation') { throw 'The validation build must use its separate application profile.' }
    $isolatedCheck = $true
}
$runningPlayers = @(Get-Process -Name loavy-player -ErrorAction SilentlyContinue)
if (($runningPlayers.Count -gt 0 -and -not $isolatedCheck) -or ($runningPlayers | Where-Object { $_.Path -eq $startupExecutable })) {
    throw 'Close the running Loavy app before running the desktop startup test.'
}
$startupApp = Start-Process -FilePath $startupExecutable -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $startupArtifacts 'release-stdout.log') `
    -RedirectStandardError (Join-Path $startupArtifacts 'release-stderr.log')

function Wait-StartupElement([string]$elementName, [string]$within = '') {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $startupApp.Refresh()
        if ($startupApp.HasExited) {
            throw ('The release app exited during startup. ' + (Get-Content (Join-Path $startupArtifacts 'release-stderr.log') -Raw))
        }
        if ($startupApp.MainWindowHandle -ne 0) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($startupApp.MainWindowHandle)
            if ($within) {
                $scope = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $within)))
                if (-not $scope) { Start-Sleep -Milliseconds 200; continue }
                $window = $scope
            }
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
    if ([LoavyStartupWindow]::GetForegroundWindow() -ne $startupApp.MainWindowHandle) { Write-Output ('Skipped capture while Loavy was not in the foreground: ' + $name); return }
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
    $null = Wait-StartupElement 'Add music'
    $spotify = Wait-StartupElement 'Spotify'
    $spotify.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'Spotify Client ID'
    $null = Wait-StartupElement 'Copy Spotify redirect URI'
    Save-DesktopCapture 'desktop-spotify-setup.png'
    $homeView = Wait-StartupElement 'Home'
    $homeView.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'Add music'
    Write-Output 'Native Spotify setup passed: sidebar route, Client ID field, and loopback redirect instructions.'
    $null = Wait-StartupElement 'Minimize window'
    $null = Wait-StartupElement 'Maximize or restore window'
    $sound = Wait-StartupElement 'Sound settings'
    $sound.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'Make it sound like you'
    $null = Wait-StartupElement 'Equalizer preset'
    $null = Wait-StartupElement 'Crossfade duration'
    $null = Wait-StartupElement 'Music visualizer'
    Save-DesktopCapture 'desktop-sound-glass.png'
    $closeSound = Wait-StartupElement 'Close dialog'
    $closeSound.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $stats = Wait-StartupElement 'Listening stats'
    $stats.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'A little more you.'
    $null = Wait-StartupElement 'Listening stats period'
    Save-DesktopCapture 'desktop-listening-stats.png'
    Write-Output 'Native sound and stats checks passed: equalizer presets, crossfade, visualizer, listening history, and integrated window controls.'
    $localMusic = Wait-StartupElement 'Local music'
    $localMusicPattern = $localMusic.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($localMusicPattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) { $localMusicPattern.Expand() }
    $navigation = Wait-StartupElement 'Downloader'
    $navigation.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'A link. A song. Yours to keep.'
    $songs = Wait-StartupElement 'Songs'
    $songs.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    if ($isolatedCheck) {
        $playFixture = Wait-StartupElement 'Play collection'
        $playFixture.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $pauseFixture = Wait-StartupElement 'Pause'
        $pauseFixture.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
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
    Save-DesktopCapture 'desktop-startup.png'
    $playlists = Wait-StartupElement 'Playlists'
    $playlists.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'New playlist'
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
        $null = Wait-StartupElement 'New playlist'
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
    $jam = Wait-StartupElement 'Room'
    $jam.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $null = Wait-StartupElement 'Same song. Same moment.'
    $join = Wait-StartupElement 'Join friends'
    $join.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $null = Wait-StartupElement 'Join your friends'
    Save-DesktopCapture 'desktop-jam-640.png'
    $null = [LoavyStartupWindow]::MoveWindow($startupApp.MainWindowHandle, 20, 20, 1100, 760, $true)
    Save-DesktopCapture 'desktop-jam-1100.png'
    Write-Output 'Native Jam checks passed: host/join forms and responsive release WebView.'
    $nowPlaying = Wait-StartupElement 'Open now playing'
    if ($nowPlaying.Current.IsEnabled) {
        $nowPlaying.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $lyricsMode = Wait-StartupElement 'Lyrics' 'Now playing'
        $lyricsMode.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        $reading = Wait-StartupElement 'Lyrics reading settings' 'Now playing'
        $reading.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
        $null = Wait-StartupElement 'Lyrics text size' 'Now playing'
        $null = Wait-StartupElement 'Word wave' 'Now playing'
        Save-DesktopCapture 'desktop-lyrics-reading-settings.png'
        $reading.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse()
        $find = Wait-StartupElement 'Find' 'Now playing'
        Save-DesktopCapture 'desktop-lyrics-1100.png'
        $find.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $null = Wait-StartupElement 'Song title and artist'
        Save-DesktopCapture 'desktop-lyrics-search.png'
        $backToLyrics = Wait-StartupElement 'Back to lyrics'
        $backToLyrics.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $null = [LoavyStartupWindow]::MoveWindow($startupApp.MainWindowHandle, 20, 20, 640, 520, $true)
        $null = Wait-StartupElement 'Download and lyric options'
        Save-DesktopCapture 'desktop-lyrics-640.png'
        $editLyrics = Wait-StartupElement 'Edit' 'Now playing'
        $editLyrics.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $wordTiming = Wait-StartupElement 'Word timing' 'Now playing'
        $wordTiming.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        $null = Wait-StartupElement 'Word timing editor' 'Now playing'
        $null = Wait-StartupElement 'Stamp next word' 'Now playing'
        Save-DesktopCapture 'desktop-word-timing-640.png'
        $cancelEdit = Wait-StartupElement 'Cancel' 'Now playing'
        $cancelEdit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $closeNowPlaying = Wait-StartupElement 'Close now playing'
        $closeNowPlaying.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output 'Native lyrics checks passed: viewer, online search form, and 1100/640-pixel layouts.'
    }
    $startupApp.Refresh()
    if ($startupApp.HasExited -or -not $startupApp.Responding) { throw 'The app stopped responding during playlist/Jam checks.' }
    Write-Output 'Release startup passed: native window, Songs, Downloader and Playlists navigation remained responsive with the existing profile.'
} finally {
    $startupApp.Refresh()
    # Stop only the exact child created by this test, never another Loavy process.
    if (-not $startupApp.HasExited) { $startupApp.Kill(); $startupApp.WaitForExit() }
}
