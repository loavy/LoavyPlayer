# Loavy Player

**A beautiful, local-first desktop music player built for your own library.**

Loavy Player organizes and plays music directly from folders on your computer. It combines a polished, customizable interface with fast local scanning, folder-based playlists, immersive playback, and optional self-hosted listening rooms.

[Download the latest release](https://github.com/loavy/LoavyPlayer/releases/latest) | [Report an issue](https://github.com/loavy/LoavyPlayer/issues)

## Highlights

- **Local-first library** - your music, metadata, artwork, and settings stay on your computer.
- **Immersive Now Playing** - large artwork, ambient background colors, complete playback controls, and true fullscreen mode.
- **Folder playlists** - browse existing music folders like a file manager and play an entire folder without recreating it as a playlist.
- **Fast library browsing** - explore songs, albums, artists, favorites, recently played tracks, and search results.
- **Highly customizable** - choose themes, accent colors, density, card style, player style, corners, background effects, font size, contrast, motion, and metadata visibility.
- **Clear playback state** - the current song is visibly highlighted throughout the library.
- **Large-library performance** - virtualized song lists, lazy artwork loading, indexed search, and background scanning.
- **Room mode** - host or join a self-hosted listening room over LAN, VPN, or a forwarded TCP port.
- **Offline mode** - disable online metadata requests whenever you want.

## Getting Started

### Install on Windows

Download the latest files from [GitHub Releases](https://github.com/loavy/LoavyPlayer/releases/latest):

- `Loavy Player_3.0.0_x64-setup.exe` - recommended installer
- `Loavy Player_3.0.0_x64_en-US.msi` - MSI package for managed installs

After installing:

1. Open **Settings**.
2. Select **Add folder** and choose a folder containing music.
3. Select **Scan** to build your local library.
4. Open **Songs**, **Albums**, **Artists**, or **Folders** and start listening.

Supported library formats include MP3, FLAC, WAV, OGG, and M4A.

## Folder Playlists

Loavy Player treats your existing folder structure as playlists.

Open **Folders** to browse every configured music directory and its subfolders. Breadcrumb navigation makes it easy to move through your collection, and **Play folder** queues all indexed music inside the selected folder and its descendants.

This works well for collections already organized by mood, artist, album, event, or custom playlist folder.

## Customization

The Appearance section in Settings includes:

- Dark and light modes
- Custom accent color
- Compact, comfortable, and spacious layouts
- Soft, flat, and glass card styles
- Docked, floating, and compact player bars
- Rounded, soft, and square corners
- Ambient, subtle, and solid backgrounds
- Adjustable font size
- Optional cover art and file-format labels
- High-contrast surfaces
- Reduced motion

Settings are saved locally and applied immediately.

## Library And Metadata

Loavy Player recursively scans selected folders, reads embedded tags and artwork, and stores the resulting library in a local SQLite database.

The scanner reads:

- Title, artist, album, and album artist
- Genre, year, and track number
- Duration and file information
- Embedded cover artwork

Scans run in the background, report progress, and can be cancelled from Settings. The app opens from its existing database and does not rescan your entire library on every launch.

MusicBrainz and Cover Art Archive integrations provide a foundation for optional metadata enrichment. Enable offline mode to prevent online metadata requests.

## Room Mode

Room mode lets a host and guests synchronize playback without relying on a central Loavy Player service.

The host can:

- Create and stop a password-protected room
- Share a LAN, VPN, or public address
- See and remove connected guests
- Allow or block guest playback control
- Broadcast the current track and playback position

Guests attempt to match the host's current song against their own local library. If no local match exists, Loavy Player can fall back to streaming the current song from the host.

### Connecting

| Situation                                   | Address to use                           |
| ------------------------------------------- | ---------------------------------------- |
| Testing on the same computer                | `127.0.0.1`                              |
| Devices on the same Wi-Fi or LAN            | The LAN/VPN address shown in Room        |
| Tailscale, ZeroTier, or another mesh VPN    | The host's VPN address                   |
| Different internet connection without a VPN | Public address after TCP port forwarding |

**Check only** verifies that an address, room name, and password work, then disconnects. **Join room** stays connected until the guest leaves, the host stops the room, or the host removes the guest.

For public connections, forward the selected TCP port to the host computer and allow it through the firewall. A trusted LAN or mesh VPN is recommended. Stop the room when it is no longer needed.

## Development

### Requirements

- Node.js 20 or newer
- Rust stable
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

### Run The Desktop App

```bash
npm install
npm run desktop:dev
```

For frontend-only development:

```bash
npm run dev
```

### Verify And Build

```bash
npm run build
cd src-tauri
cargo check
cd ..
npm run desktop:build
```

Desktop bundles are written to:

```text
src-tauri/target/release/bundle/
```

Attach generated installers to a GitHub Release instead of committing them to the repository.

## Tech Stack

| Layer                   | Technology                 |
| ----------------------- | -------------------------- |
| Desktop shell           | Tauri 2                    |
| Interface               | React 18, TypeScript, Vite |
| Native backend          | Rust                       |
| Local database          | SQLite via rusqlite        |
| Audio metadata          | lofty                      |
| Icons                   | Lucide React               |
| Async runtime and rooms | Tokio                      |

## Project Structure

```text
src/
  components/       Shared React components and playback UI
  lib/              Tauri API client, audio engine, and formatting helpers
  views/            Songs, albums, artists, folders, rooms, and settings

src-tauri/
  src/db/           SQLite schema and queries
  src/fetchers/     Metadata provider system
  src/library/      Recursive scanner, tag reader, and cover extraction
  src/room/         Self-hosted Room protocol and server
  src/commands.rs   Tauri command boundary
```

## Privacy

Loavy Player is designed around a local library:

- Music files are played directly from your computer.
- Library metadata and settings are stored locally.
- Online metadata requests can be disabled with offline mode.
- Room mode is self-hosted by the user.

## Contributing

Contributions, bug reports, and feature ideas are welcome. Before submitting a change:

1. Open an issue or describe the intended change clearly.
2. Keep changes focused and consistent with the existing architecture.
3. Run `npm run build` and `cargo check`.
4. Include screenshots for visible interface changes.

Use [GitHub Issues](https://github.com/loavy/LoavyPlayer/issues) to report bugs or suggest improvements.
