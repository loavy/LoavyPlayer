# Loavy Player Privacy Policy

Effective date: July 11, 2026

Loavy Player is primarily a local music player. This policy explains what information the application processes when you use its local library, optional online metadata, downloader, and Room/Jam features.

## Local music library

When you select a music folder, Loavy Player scans files in that folder and reads information needed to organize and play them, including file paths, filenames, embedded tags, duration, format, and embedded artwork. Library records, favorites, playlists, settings, artwork caches, and related application data are stored locally on your device.

Loavy Player does not upload your audio library to a Loavy-operated server.

## Optional metadata services

If online metadata features are used and Offline mode is not enabled, Loavy Player may send a track title, artist, album name, or MusicBrainz release identifier to third-party services such as MusicBrainz and the Cover Art Archive. These services receive the network request and may process information such as your IP address under their own privacy policies.

You can prevent these metadata requests by enabling Offline mode.

## Optional downloader

The Downloader runs only when you provide a media URL and start a download.

For a direct link, Loavy Player uses yt-dlp to contact the website represented by the URL and any media hosts needed for that download. For a Spotify link, Loavy Player uses spotDL to request public Spotify catalog metadata and artwork, search for a matching recording through YouTube or YouTube Music, and request the selected media from the matching host. Spotify links are normalized before processing so their sharing/tracking query string is not retained in subprocess logs or caches.

On first use, Loavy Player downloads yt-dlp, spotDL, and FFmpeg from pinned GitHub release URLs. Every managed executable is checksum-verified before use. Tool configuration and caches are kept under Loavy Player's local app-data `tools` folder. Loavy Player does not import Spotify, browser, or media-site account credentials or cookies.

Spotify, Google/YouTube, GitHub, the website supplied for a direct download, and any media hosts involved receive the relevant network requests and may process information such as your IP address, requested URL or catalog identifier, and standard connection metadata under their own privacy policies and terms. Loavy Player does not proxy these requests through a Loavy-operated server.

## Optional Room/Jam networking

Room/Jam is an optional peer-to-peer feature for devices connected through a LAN, Wi-Fi network, VPN, or manually configured network route. When you host or join a room, Loavy Player may exchange a display name, room and playback state, track metadata, and audio data directly with the participating devices. If guest song sharing is enabled, a song selected by a guest may be transferred to and saved on the host's device.

Loavy Player does not operate a central Room/Jam server. Room participants and the operators of the network or VPN may process data exchanged through the session.

## Sale, advertising, and analytics

Loavy Player does not sell user data. The application does not include a Loavy-operated advertising or behavioral analytics service.

## Storage, retention, and user choices

Local library and settings data remain on the device until they are removed by the user. Downloaded or Room/Jam-transferred audio files remain in the selected folders until the user deletes them. Users can remove configured music folders, clear application data, delete downloaded files, enable Offline mode, and choose not to use the Downloader or Room/Jam features.

## Changes to this policy

This policy may be updated when Loavy Player's features or data practices change. The effective date above will be updated when a revised policy is published.

## Contact

Project repository: <https://github.com/loavy/LoavyPlayer>
