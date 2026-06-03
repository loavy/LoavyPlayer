import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  Artist,
  FetcherDescriptor,
  MusicFolder,
  RoomCreateRequest,
  RoomClientStatus,
  RoomJoinRequest,
  RoomJoinResult,
  RoomPlaybackState,
  RoomStatus,
  Playlist,
  ScanSummary,
  ScanTaskState,
  Track
} from "../types";

export const api = {
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
  findRoomPlaybackTrack: (playback: RoomPlaybackState) =>
    invoke<Track | null>("find_room_playback_track", { playback }),
  listAlbums: () => invoke<Album[]>("list_albums"),
  listArtists: () => invoke<Artist[]>("list_artists"),
  listPlaylists: () => invoke<Playlist[]>("list_playlists"),
  createPlaylist: (name: string) => invoke<Playlist>("create_playlist", { name }),
  addTrackToPlaylist: (playlistId: number, trackId: number) =>
    invoke<void>("add_track_to_playlist", { playlistId, trackId }),
  listPlaylistTracks: (playlistId: number) =>
    invoke<Track[]>("list_playlist_tracks", { playlistId }),
  listFetchers: () => invoke<FetcherDescriptor[]>("list_fetchers"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { update: { key, value } }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setApiKey: (provider: string, keyValue: string) =>
    invoke<void>("set_api_key", { update: { provider, keyValue } }),
  createRoom: (request: RoomCreateRequest) => invoke<RoomStatus>("create_room", { request }),
  stopRoom: () => invoke<void>("stop_room"),
  getRoomStatus: () => invoke<RoomStatus>("get_room_status"),
  joinRoomProbe: (request: RoomJoinRequest) => invoke<RoomJoinResult>("room_join_probe", { request }),
  joinRoom: (request: RoomJoinRequest) => invoke<RoomJoinResult>("room_join", { request }),
  leaveRoom: () => invoke<void>("room_leave"),
  getRoomClientStatus: () => invoke<RoomClientStatus>("get_room_client_status"),
  sendGuestPlaybackState: (playback: RoomPlaybackState) =>
    invoke<void>("room_send_guest_playback_state", { playback: sanitizeRoomPlayback(playback) }),
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
