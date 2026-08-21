import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  Artist,
  DownloadResult,
  DownloaderStatus,
  DiscoveredRoom,
  FetcherDescriptor,
  FolderDeleteResult,
  FolderInspection,
  FolderRenameResult,
  LibraryFolderEntry,
  LibraryFolderListing,
  MusicFolder,
  MediaDownloadRequest,
  RoomCreateRequest,
  RoomClientStatus,
  RoomJoinRequest,
  RoomJoinResult,
  RoomPlaybackState,
  RoomStatus,
  Playlist,
  ScanSummary,
  ScanTaskState,
  Track,
  TrackDeleteResult,
  TrackLyrics,
  TrackLyricsUpdate,
  TrackPlaybackStats
} from "../types";

export const api = {
  setBackgroundMode: (enabled: boolean) => invoke<void>("set_background_mode", { enabled }),
  selectMusicFolder: () => invoke<MusicFolder | null>("select_music_folder"),
  listMusicFolders: () => invoke<MusicFolder[]>("list_music_folders"),
  removeMusicFolder: (folderId: number) => invoke<void>("remove_music_folder", { folderId }),
  scanLibrary: () => invoke<ScanSummary>("scan_library"),
  startLibraryScan: () => invoke<void>("start_library_scan"),
  cancelLibraryScan: () => invoke<void>("cancel_library_scan"),
  getScanState: () => invoke<ScanTaskState>("get_scan_state"),
  listTracks: (query?: string) => invoke<Track[]>("list_tracks", { query: query || null }),
  setTrackFavorite: (trackId: number, favorite: boolean) =>
    invoke<void>("set_track_favorite", { trackId, favorite }),
  markTrackPlayed: (trackId: number) =>
    invoke<TrackPlaybackStats>("mark_track_played", { trackId }),
  revealTrack: (trackId: number) => invoke<void>("reveal_track", { trackId }),
  deleteTrackToTrash: (trackId: number) =>
    invoke<TrackDeleteResult>("delete_track_to_trash", { trackId }),
  getTrackLyrics: (trackId: number) =>
    invoke<TrackLyrics | null>("get_track_lyrics", { trackId }),
  saveTrackLyrics: (request: TrackLyricsUpdate) =>
    invoke<TrackLyrics>("save_track_lyrics", { request }),
  deleteTrackLyrics: (trackId: number) =>
    invoke<void>("delete_track_lyrics", { trackId }),
  importTrackLyrics: (trackId: number) =>
    invoke<TrackLyrics | null>("import_track_lyrics", { trackId }),
  findRoomPlaybackTrack: (playback: RoomPlaybackState) =>
    invoke<Track | null>("find_room_playback_track", { playback }),
  listAlbums: () => invoke<Album[]>("list_albums"),
  listArtists: () => invoke<Artist[]>("list_artists"),
  listPlaylists: () => invoke<Playlist[]>("list_playlists"),
  createPlaylist: (name: string) => invoke<Playlist>("create_playlist", { name }),
  renamePlaylist: (playlistId: number, name: string) =>
    invoke<Playlist>("rename_playlist", { playlistId, name }),
  deletePlaylist: (playlistId: number) =>
    invoke<void>("delete_playlist", { playlistId }),
  addTrackToPlaylist: (playlistId: number, trackId: number) =>
    invoke<void>("add_track_to_playlist", { playlistId, trackId }),
  removeTrackFromPlaylist: (playlistId: number, trackId: number) =>
    invoke<void>("remove_track_from_playlist", { playlistId, trackId }),
  reorderPlaylistTracks: (playlistId: number, trackIds: number[]) =>
    invoke<void>("reorder_playlist_tracks", { playlistId, trackIds }),
  listPlaylistTracks: (playlistId: number) =>
    invoke<Track[]>("list_playlist_tracks", { playlistId }),
  listLibraryFolder: (rootId: number, relativePath: string) =>
    invoke<LibraryFolderListing>("list_library_folder", { rootId, relativePath }),
  createLibraryFolder: (rootId: number, parentRelativePath: string, name: string) =>
    invoke<LibraryFolderEntry>("create_library_folder", { rootId, parentRelativePath, name }),
  renameLibraryFolder: (rootId: number, relativePath: string, name: string) =>
    invoke<FolderRenameResult>("rename_library_folder", { rootId, relativePath, name }),
  inspectLibraryFolder: (rootId: number, relativePath: string) =>
    invoke<FolderInspection>("inspect_library_folder", { rootId, relativePath }),
  deleteLibraryFolderToTrash: (rootId: number, relativePath: string) =>
    invoke<FolderDeleteResult>("delete_library_folder_to_trash", { rootId, relativePath }),
  revealLibraryFolder: (rootId: number, relativePath: string) =>
    invoke<void>("reveal_library_folder", { rootId, relativePath }),
  listFetchers: () => invoke<FetcherDescriptor[]>("list_fetchers"),
  downloadMedia: (request: MediaDownloadRequest) =>
    invoke<DownloadResult>("download_media", { request }),
  getDownloaderStatus: () => invoke<DownloaderStatus>("get_downloader_status"),
  cancelMediaDownload: () => invoke<void>("cancel_media_download"),
  selectDownloadFolder: () => invoke<string | null>("select_download_folder"),
  getDefaultGuestSongFolder: () => invoke<string | null>("get_default_guest_song_folder"),
  selectGuestSongFolder: () => invoke<string | null>("select_guest_song_folder"),
  revealDownload: (path: string) => invoke<void>("reveal_download", { path }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { update: { key, value } }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setApiKey: (provider: string, keyValue: string) =>
    invoke<void>("set_api_key", { update: { provider, keyValue } }),
  createRoom: (request: RoomCreateRequest) => invoke<RoomStatus>("create_room", { request }),
  stopRoom: () => invoke<void>("stop_room"),
  getRoomStatus: () => invoke<RoomStatus>("get_room_status"),
  discoverRooms: () => invoke<DiscoveredRoom[]>("discover_rooms"),
  joinRoomProbe: (request: RoomJoinRequest) => invoke<RoomJoinResult>("room_join_probe", { request }),
  joinRoom: (request: RoomJoinRequest) => invoke<RoomJoinResult>("room_join", { request }),
  leaveRoom: () => invoke<void>("room_leave"),
  getRoomClientStatus: () => invoke<RoomClientStatus>("get_room_client_status"),
  sendGuestPlaybackState: (playback: RoomPlaybackState) =>
    invoke<void>("room_send_guest_playback_state", { playback: sanitizeRoomPlayback(playback) }),
  sendGuestTrack: (playback: RoomPlaybackState, path: string) =>
    invoke<void>("room_send_guest_track", { playback: sanitizeRoomPlayback(playback), path }),
  requestHostScan: () => invoke<void>("room_request_host_scan"),
  broadcastRoomPlaybackState: (playback: RoomPlaybackState) =>
    invoke<void>("room_broadcast_playback_state", { playback: sanitizeRoomPlayback(playback) }),
  kickRoomUser: (userId: number) => invoke<void>("room_kick_user", { userId })
};

function intOrNull(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function sanitizeRoomPlayback(playback: RoomPlaybackState): RoomPlaybackState {
  return {
    ...playback,
    trackId: intOrNull(playback.trackId),
    durationMs: intOrNull(playback.durationMs),
    positionMs: Math.max(0, Math.round(playback.positionMs || 0)),
    hostTimestampMs: Math.max(0, Math.round(playback.hostTimestampMs || Date.now()))
  };
}
