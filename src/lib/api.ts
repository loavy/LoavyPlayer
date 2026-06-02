import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  Artist,
  FetcherDescriptor,
  MusicFolder,
  RoomCreateRequest,
  RoomJoinRequest,
  RoomJoinResult,
  RoomPlaybackState,
  RoomStatus,
  ScanSummary,
  ScanTaskState,
  Track
} from "../types";

export const api = {
  selectMusicFolder: () => invoke<MusicFolder | null>("select_music_folder"),
  listMusicFolders: () => invoke<MusicFolder[]>("list_music_folders"),
  scanLibrary: () => invoke<ScanSummary>("scan_library"),
  startLibraryScan: () => invoke<void>("start_library_scan"),
  cancelLibraryScan: () => invoke<void>("cancel_library_scan"),
  getScanState: () => invoke<ScanTaskState>("get_scan_state"),
  listTracks: (query?: string) => invoke<Track[]>("list_tracks", { query: query || null }),
  listAlbums: () => invoke<Album[]>("list_albums"),
  listArtists: () => invoke<Artist[]>("list_artists"),
  listFetchers: () => invoke<FetcherDescriptor[]>("list_fetchers"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { update: { key, value } }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setApiKey: (provider: string, keyValue: string) =>
    invoke<void>("set_api_key", { update: { provider, keyValue } }),
  createRoom: (request: RoomCreateRequest) => invoke<RoomStatus>("create_room", { request }),
  stopRoom: () => invoke<void>("stop_room"),
  getRoomStatus: () => invoke<RoomStatus>("get_room_status"),
  joinRoomProbe: (request: RoomJoinRequest) => invoke<RoomJoinResult>("room_join_probe", { request }),
  broadcastRoomPlaybackState: (playback: RoomPlaybackState) =>
    invoke<void>("room_broadcast_playback_state", { playback }),
  kickRoomUser: (userId: number) => invoke<void>("room_kick_user", { userId })
};
