# Loavy Player

Loavy Player is a local-first cross-platform desktop music player for Windows and Linux. It is built with Tauri, React, TypeScript, Rust, and SQLite.

## Why Tauri

Tauri gives Loavy Player a real desktop shell with native installers and a small footprint. Rust handles the work that benefits from native speed and reliability: recursive scanning, metadata extraction, cover caching, SQLite, and metadata fetchers. React keeps the customizable UI modular and fast to iterate.

## MVP Features

- Select local music folders.
- Recursively scan MP3, FLAC, WAV, OGG, and M4A files.
- Read title, artist, album, genre, year, track number, duration, and embedded covers.
- Store the library in a local SQLite database.
- Songs, albums, artists, search, settings, and reserved future views.
- Local playback with play, pause, stop, next, previous, seek, volume, shuffle, and repeat.
- Theme mode and accent color settings.
- Modular fetcher registry with MusicBrainz and Cover Art Archive providers.
- Offline mode setting for metadata fetches.
- Cancellable background scans with progress events.
- Virtualized song list rendering for large libraries.
- Self-hosted Room/Jam control server skeleton for LAN/VPN playback state sync.

## Requirements

- Node.js 20 or newer.
- Rust stable.
- Platform prerequisites for Tauri 2:
  - Windows: Microsoft C++ Build Tools and WebView2.
  - Linux: WebKitGTK and common build packages. See the Tauri Linux prerequisites for your distribution.

## Development

```bash
npm install
npm run desktop:dev
```

For frontend-only iteration:

```bash
npm run dev
```

## Build

```bash
npm run desktop:build
```

Tauri will place Windows installers or Linux packages under `src-tauri/target/release/bundle`.

On Windows, the friendliest file to send testers is the NSIS installer:

```text
src-tauri/target/release/bundle/nsis/Loavy Player_0.1.0_x64-setup.exe
```

The MSI installer is also available for managed installs:

```text
src-tauri/target/release/bundle/msi/Loavy Player_0.1.0_x64_en-US.msi
```

Do not commit these built installers to GitHub unless you intentionally want binary releases in the repository. Prefer attaching them to a GitHub Release.

## Folder Structure

```text
src/
  components/       shared React components
  lib/              Tauri API client, playback engine, formatting helpers
  views/            library and settings screens
src-tauri/
  src/audio/        future native playback/media-key backend
  src/db/           SQLite schema and queries
  src/fetchers/     modular metadata provider system
  src/library/      scanner, tag reader, cover extraction
  src/room/         self-hosted Room/Jam protocol and LAN server
  src/commands.rs   Tauri command boundary
```

## Fetcher Design

Each provider implements `MetadataFetcher` in `src-tauri/src/fetchers`. Providers declare capabilities such as album art, lyrics, biographies, genre tags, similar artists, or metadata correction. API-key providers should store user-supplied keys in the local `api_keys` table; private keys are never hardcoded.

## Responsiveness Model

- The app opens from the local SQLite database and does not rescan on startup.
- Folder scans run in a background task and emit `library://scan-progress`, `library://scan-finished`, and `library://scan-error` events.
- Scans can be cancelled from the Settings screen.
- The songs view is virtualized so large libraries do not render every row at once.
- Album art is loaded lazily from the local Tauri asset protocol.
- Search is debounced in the UI and backed by indexed SQLite columns.

## Room / Jam Mode

The Room feature is designed as a self-hosted LAN/VPN system, not a cloud service. The host starts a local TCP control server and guests join with host address, port, room name, and password.

Current MVP implementation:

- Host creates/stops a room from the Room view.
- Host can choose a port and share LAN/VPN or public join info.
- Host can see connected users and kick guests.
- Room name/password validation.
- Join probe authenticates against a real local server.
- Typed line-delimited JSON protocol.
- Host periodically broadcasts playback state: current song metadata, position, play/pause, timestamp.
- Protocol includes queue and heartbeat message types so queue sync and reconnect logic can be added without rewriting the transport.

For guests outside your home network, the host must either forward the chosen TCP port to the host PC or use a mesh/VPN tool such as Tailscale, ZeroTier, or Radmin VPN. There is no central relay server in the MVP.

Next Room step:

- Add a persistent client listener in the UI.
- Add `/stream/current` or a dedicated TCP audio stream endpoint with range/buffering support.
- Add gentle drift correction and visible buffering/sync states.

## Next Feature Pass

- Playlist create/edit/delete and M3U import/export.
- Lyrics view with LRCLIB synced/plain lyric fetches and local editing.
- Favorites, recently played persistence, and queue editor.
- Native media keys and optional native audio output device selection.
- File watcher support for incremental automatic rescans.
- Room audio streaming endpoint and persistent guest client playback.
- Last.fm, Deezer, Spotify, Discogs, and optional Genius-safe providers.
