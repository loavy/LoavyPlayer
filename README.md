# Loavy Player

Loavy Player is a local-first desktop music player for Windows, built with Tauri, Rust, React, and TypeScript. It scans music already on your computer, reads embedded metadata and artwork, and keeps the library in a local SQLite database.

[Download the latest release](https://github.com/loavy/LoavyPlayer/releases/latest) | [Report a bug](https://github.com/loavy/LoavyPlayer/issues)

## What It Does

- Plays MP3, FLAC, WAV, OGG/OGA, Opus, M4A, and AAC files from local folders.
- Browses songs, albums, artists, favorites, recent tracks, and folder playlists.
- Reads embedded tags and cover art without uploading the library.
- Provides a fullscreen Now Playing view and customizable player layout.
- Downloads a single song or a complete playlist with yt-dlp.
- Hosts self-managed listening rooms for LAN, VPN, or port-forwarded connections.
- Supports dark and light themes, density controls, reduced motion, and high contrast.

## Install On Windows

Download the setup file from [GitHub Releases](https://github.com/loavy/LoavyPlayer/releases/latest):

- `Loavy Player_4.1.2_x64-setup.exe`

During setup, Loavy asks whether to install optional **Tools**. Choosing **Yes** opens the official Microsoft Store listing for Web Media Extensions after Loavy is installed. This adds Windows support for OGG, Opus, and related web media formats. Choosing **No** skips it without affecting the main installation.

After installation:

1. Open **Settings**.
2. Select **Add folder** and choose a music folder.
3. Select **Scan**.
4. Open **Songs**, **Albums**, **Artists**, or **Folders**.

The first scan can take a little longer when a folder contains many files or large embedded covers. Later launches use the saved database and do not automatically rebuild the whole library.

## Downloader

Open **Downloader**, select **Single song** or **Playlist**, paste a supported media URL, and start the download. The default destination is:

```text
Downloads/Loavy Player
```

Use the folder button beside **Save to** to choose another destination. Loavy asks yt-dlp for the best available audio and prefers M4A, which the player can scan directly. Playlist downloads are placed in a folder named after the playlist and prefixed with track numbers.

Loavy downloads the official Windows `yt-dlp` executable on first use and stores it in the app-data `tools` folder. This one-time setup is approximately 18 MB. See the [yt-dlp supported sites list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) for extractor coverage.

Recent yt-dlp versions recommend a JavaScript runtime for full YouTube support. Loavy automatically uses Node.js when version 22 or newer is installed; many downloads still work without it, but some YouTube formats may be unavailable.

The downloader does not bypass subscriptions, DRM, private access, or regional restrictions. Only download media you own or have permission to save, and follow the source website's terms.

To add a downloaded track to the library, save it inside a configured music folder and run **Scan** from Settings.

## Folder Playlists

The **Folders** view uses your existing directory structure as a set of playlists. Breadcrumbs navigate subfolders, and **Play folder** queues indexed tracks from the selected folder and its descendants.

## Listening Rooms

A host can create a password-protected room, share playback state, allow or block guest controls, and remove connected guests. Guests first match the host track against their local library; when no match exists, Loavy can stream the current host file.

| Connection | Host address |
| --- | --- |
| Same computer | `127.0.0.1` |
| Same Wi-Fi or LAN | The host's LAN address |
| Tailscale, ZeroTier, or another VPN | The host's VPN address |
| Public internet | Public address with the selected TCP port forwarded |

Use **Check only** to verify the address, room name, and password without staying connected. A trusted LAN or mesh VPN is recommended. Stop the room when it is no longer needed.

## Privacy

- Audio is read directly from local storage.
- Library data and settings are stored on the device.
- Offline mode disables optional online metadata requests.
- Downloader requests are made by yt-dlp to the supplied site and its media hosts; the first run also downloads yt-dlp from GitHub.
- Rooms are hosted by the user; Loavy does not provide a central room service.

## Development

### Requirements

- Node.js 20 or newer.
- Rust stable with the MSVC toolchain.
- Microsoft C++ Build Tools and WebView2, as required by [Tauri 2 on Windows](https://v2.tauri.app/start/prerequisites/).

Install dependencies and run the desktop app:

```powershell
npm install
npm run desktop:dev
```

Run only the browser frontend:

```powershell
npm run dev
```

The browser-only frontend cannot call native library, room, dialog, or downloader commands. Use `desktop:dev` to test the complete app.

### Verify

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

### Build Installers

```powershell
npm run desktop:build
```

Generated Windows bundles are written under:

```text
src-tauri/target/release/bundle/nsis/
src-tauri/target/release/bundle/msi/
```

## Project Layout

```text
src/
  components/        Shared navigation and playback UI
  lib/               Tauri API client and audio helpers
  views/             Library, downloader, room, and settings views

src-tauri/src/
  db/                SQLite schema and queries
  downloader.rs      Managed yt-dlp process and progress parser
  library/           Folder scanner, tags, and artwork
  room/              Host and guest room protocol
  commands.rs        Tauri command boundary
```

## Troubleshooting

**The app does not show a new file**

Make sure the file is inside a configured music folder, uses a supported format, and run **Scan** again.

**A YouTube download reports missing formats**

Install Node.js 22 or newer and restart Loavy. yt-dlp uses it for newer YouTube JavaScript challenges.

**An Opus or OGG track is indexed but does not play**

Install Microsoft's [Web Media Extensions](https://apps.microsoft.com/detail/9n5tdp8vcmhs). The standard setup installer can open this listing through its optional Tools prompt.

**A playlist finishes with fewer songs than expected**

Private, deleted, region-blocked, or otherwise unavailable entries are skipped so the rest of the playlist can finish.

**A website login is required**

Loavy does not import browser cookies or account credentials. Use a public URL that yt-dlp can access without authentication.

**The frontend build reports `crypto.getRandomValues`**

Upgrade to Node.js 20 or newer, reopen the terminal, and run `npm install` again.

**`cargo` is not recognized**

Install Rust with [rustup](https://rustup.rs/), select the stable MSVC toolchain, and reopen the terminal.

## Contributing

Keep changes focused and consistent with the existing architecture. Before opening a pull request, run the frontend build and Rust tests, and include screenshots for visible interface changes.
