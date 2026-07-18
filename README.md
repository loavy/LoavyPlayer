<div align="center">

  <img width="300" alt="icon-master" src="https://github.com/user-attachments/assets/c7a983d3-9a3d-4fee-b52b-44439e065b30" />
  
  # Loavy Player

</div>

Loavy Player is a local-first desktop music player for Windows, built with Tauri, Rust, React, and TypeScript. It scans music already on your computer, reads embedded metadata and artwork, and keeps the library in a local SQLite database.

[Download the latest release](https://github.com/loavy/LoavyPlayer/releases/latest) | [Report a bug](https://github.com/loavy/LoavyPlayer/issues)

## What It Does

- Plays MP3, FLAC, WAV, OGG/OGA, Opus, M4A, and AAC files from local folders.
- Browses songs, albums, artists, favorites, recent tracks, and folder playlists.
- Reads embedded tags and cover art without uploading the library.
- Provides a fullscreen Now Playing view and customizable player layout.
- Can keep playback running in the Windows system tray after the main window is closed.
- Accepts Spotify track, album, and playlist links through a metadata-matching download flow.
- Downloads supported direct media links with yt-dlp.
- Hosts self-managed listening rooms for LAN, VPN, or port-forwarded connections.
- Supports dark and light themes, density controls, reduced motion, and high contrast.

## Install On Windows

Download the setup file from [GitHub Releases](https://github.com/loavy/LoavyPlayer/releases/latest):

During setup, Loavy asks whether to install optional **Tools**. Choosing **Yes** opens the official Microsoft Store listing for Web Media Extensions after Loavy is installed. This adds Windows support for OGG, Opus, and related web media formats. Choosing **No** skips it without affecting the main installation.

After installation:

1. Open **Settings**.
2. Select **Add folder** and choose a music folder.
3. Select **Scan**.
4. Open **Songs**, **Albums**, **Artists**, or **Folders**.

The first scan can take a little longer when a folder contains many files or large embedded covers. Later launches use the saved database and do not automatically rebuild the whole library.

## Downloader

Open **Downloader** and choose a source. The default destination is:

```text
Downloads/Loavy Player
```

Use the folder button beside **Save to** to choose another destination. M4A, MP3, Opus, and FLAC output are available; M4A is the recommended default for good quality without unnecessary transcoding.

Use the **Naming** tab to choose how downloaded files and collection folders are organized. The default filename is `{artist} - {title}` (the audio extension is added automatically), and the default collection folder is `{album_artist}/{album}`. Metadata token buttons can insert track, disc, date, ISRC, playlist, and position fields; these choices are saved on this device. Folder structure applies to albums and playlists by default and can optionally be enabled for single tracks.

### Spotify links

Paste a public `open.spotify.com` track, album, or playlist URL in the **Spotify** tab. Loavy uses spotDL to read the catalog metadata, find a matching public audio upload (normally through YouTube/YouTube Music), download it, and embed the title, artist, album, and artwork. The **Naming** settings control the resulting filenames and folders.

Spotify supplies identity and metadata only: Loavy does **not** download Spotify's audio stream. The quality is limited by the matched source. Selecting FLAC converts that source into a FLAC file; it cannot recreate lossless detail that was not present in the source.

The first Spotify download installs pinned Windows releases of spotDL and FFmpeg in Loavy's app-data `tools` folder. Their combined download is approximately 121 MB. Both files are checksum-verified before use.

### Direct links

Paste a supported public media URL in the **Direct link** tab and choose whether it is a single item or playlist. Loavy uses yt-dlp for extraction and FFmpeg for the selected output format. The first direct download installs those managed tools in the app-data `tools` folder. See the [yt-dlp supported sites list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) for extractor coverage.

Current yt-dlp releases recommend a JavaScript runtime for complete YouTube support. Loavy uses Node.js when it is available on `PATH`; many downloads work without it, but some formats may be unavailable.

The downloader does not bypass subscriptions, DRM, private access, or regional restrictions. Only download media you own or have permission to save, and follow the source website's terms.

To add a downloaded track to the library, save it inside a configured music folder and run **Scan** from Settings.

## Folder Playlists

The **Folders** view uses your existing directory structure as a set of playlists. Breadcrumbs navigate subfolders, and **Play folder** queues indexed tracks from the selected folder and its descendants.

## Room & Jam Mode

Room & Jam Mode creates a private, host-managed listening session. Loavy synchronizes play, pause, seeking, and song changes without a central Loavy server.

### Start a room

1. Connect everyone to the same Wi-Fi/LAN or the same VPN.
2. Open **Room**, choose a room name and a password of at least four characters.
3. Enable **Guests can change songs** if guests should be allowed to control playback.
4. When guest control is enabled, received songs default to the host's **Music** folder; choose another folder if preferred.
5. Select **Start room** and allow Loavy through Windows Firewall on private networks.

The status panel lists every usable network adapter. Friends on the same Wi-Fi should use the Wi-Fi/LAN address. Friends connecting remotely through Tailscale, ZeroTier, Radmin VPN, Hamachi, WireGuard, or a similar service must use the address belonging to that VPN adapter. A public internet IP is not the VPN address and will not normally work.

### Join a room

1. Wait until the host has started the room.
2. Select **Search** under **Rooms nearby**.
3. Select the discovered room, enter its password and your display name, then choose **Join room**.
4. If discovery is unavailable, enter the host's VPN address and room port manually. Use **Check only** to test the details first.

Nearby discovery uses UDP broadcast/multicast. Some routed mesh VPNs block that traffic even though direct connections work, so manual entry remains available.

### Guest-selected songs

When guest control is enabled, a guest can select a song from their own Loavy library. Playback begins after a small initial buffer while the rest of the file continues transferring. The completed file remains in the folder chosen by the host; duplicate filenames receive a numbered suffix instead of replacing an existing file.

Guests first try to match host playback against their local libraries. If no local match exists, they stream the host's copy.

### Connection checklist

- Same computer: use `127.0.0.1`.
- Same Wi-Fi/LAN: use the host's Wi-Fi or Ethernet adapter address.
- Different physical networks: join the same VPN and use the host's VPN adapter address.
- Default room port: TCP `39177`.
- Nearby discovery: UDP `39176`.
- If the room is not discovered, use manual connection before changing firewall settings.
- Stop the room when the session is finished.

## Privacy

- Audio is read directly from local storage.
- Library data and settings are stored on the device.
- Offline mode disables optional online metadata requests.
- Downloader requests go to the pasted site or, for Spotify links, to Spotify metadata services and matched YouTube/YouTube Music media. Managed tools come from pinned, checksum-verified GitHub releases.
- Rooms are hosted by the user; Loavy does not provide a central room service.

See the full [Loavy Player privacy policy](PRIVACY.md).

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

For a Microsoft Store-compatible NSIS build with the offline WebView2 installer:

```powershell
npm run desktop:store
```

See the [Microsoft Store publishing checklist](docs/MICROSOFT_STORE.md) before submitting the installer.

## Project Layout

```text
src/
  components/        Shared navigation and playback UI
  lib/               Tauri API client and audio helpers
  views/             Library, downloader, room, and settings views

src-tauri/src/
  db/                SQLite schema and queries
  downloader.rs      Downloader request routing and shared models
  downloader/        Managed yt-dlp and Spotify-link download engines
  library/           Folder scanner, tags, and artwork
  room/              Host and guest room protocol
  commands.rs        Tauri command boundary
```

## Troubleshooting

**The app does not show a new file**

Make sure the file is inside a configured music folder, uses a supported format, and run **Scan** again.

**A YouTube download reports missing formats**

Install a current Node.js release, make sure `node` is on `PATH`, and restart Loavy. yt-dlp uses it for newer YouTube JavaScript challenges.

**A Spotify link has no matching audio**

Spotify mode relies on a separate public audio match. A private, region-blocked, newly released, or unusually named track may have no suitable match even though it is playable in Spotify.

**Is Spotify FLAC output lossless?**

No. Spotify mode does not obtain Spotify or subscription-service audio. FLAC is offered as an output container, but conversion cannot improve the matched source quality.

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

## License / Usage

This repository does not currently include an explicit open-source license. No license is currently granted unless stated otherwise.

Separately licensed downloader tools and upstream design notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

© 2026 Loavy. All rights reserved.
