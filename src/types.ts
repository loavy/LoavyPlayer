export type Track = {
  id: number;
  path: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  modifiedAt: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  durationMs?: number | null;
  coverPath?: string | null;
  favorite: boolean;
  dateAdded: number;
  lastPlayedAt?: number | null;
  playCount: number;
};

export type Album = {
  title: string;
  artist?: string | null;
  year?: number | null;
  coverPath?: string | null;
  trackCount: number;
};

export type Artist = {
  name: string;
  trackCount: number;
  albumCount: number;
};

export type MusicFolder = {
  id: number;
  path: string;
  enabled: boolean;
  createdAt: number;
  lastScannedAt?: number | null;
};

export type ScanSummary = {
  foldersScanned: number;
  filesSeen: number;
  tracksAddedOrUpdated: number;
  tracksRemoved: number;
  errors: string[];
};

export type ScanProgress = {
  running: boolean;
  foldersScanned: number;
  totalFiles: number;
  filesSeen: number;
  tracksAddedOrUpdated: number;
  tracksRemoved: number;
  currentPath?: string | null;
  cancelled: boolean;
  errors: string[];
};

export type ScanTaskState = {
  running: boolean;
  cancelRequested: boolean;
};

export type FetcherDescriptor = {
  id: string;
  name: string;
  capabilities: string[];
  requiresApiKey: boolean;
};

export type ViewKey =
  | "songs"
  | "albums"
  | "artists"
  | "playlists"
  | "recent"
  | "favorites"
  | "room"
  | "downloader"
  | "settings";

export type RepeatMode = "off" | "all" | "one";

export type DownloadMode = "single" | "playlist";

export type MediaDownloadRequest = {
  url: string;
  destinationDir?: string | null;
  mode: DownloadMode;
};

export type DownloadProgress = {
  phase: "installing" | "starting" | "downloading";
  percent: number | null;
  bytesWritten: number;
  totalBytes: number | null;
  title: string;
  itemIndex: number | null;
  itemCount: number | null;
};

export type DownloadResult = {
  url: string;
  destination: string;
  files: string[];
  downloadedCount: number;
  mode: DownloadMode;
};

export type DownloaderStatus = {
  installed: boolean;
  version: string | null;
  running: boolean;
};

export type RoomCreateRequest = {
  name: string;
  password: string;
  maxUsers?: number | null;
  allowGuestQueue: boolean;
  allowGuestControl: boolean;
  guestSongDir?: string | null;
  bindAddr?: string | null;
  port?: number | null;
};

export type RoomJoinRequest = {
  host: string;
  port: number;
  roomName: string;
  password: string;
  displayName: string;
};

export type RoomStatus = {
  running: boolean;
  name?: string | null;
  bindAddr?: string | null;
  port?: number | null;
  shareAddr?: string | null;
  publicAddr?: string | null;
  localJoin?: string | null;
  publicJoin?: string | null;
  connectedUsers: number;
  users: RoomUser[];
  maxUsers?: number | null;
  allowGuestQueue: boolean;
  allowGuestControl: boolean;
  guestSongDir?: string | null;
  networkAddresses: RoomNetworkAddress[];
};

export type RoomNetworkAddress = {
  interfaceName: string;
  address: string;
  joinAddress: string;
};

export type RoomUser = {
  id: number;
  displayName: string;
  remoteAddr: string;
  joinedAt: number;
};

export type RoomPlaybackState = {
  trackId?: number | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  coverPath?: string | null;
  streamPath?: string | null;
  durationMs?: number | null;
  positionMs: number;
  playing: boolean;
  hostTimestampMs: number;
};

export type Playlist = {
  id: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
};

export type RoomJoinResult = {
  success: boolean;
  message: string;
  playback?: RoomPlaybackState | null;
};

export type RoomClientStatus = {
  connected: boolean;
  host?: string | null;
  port?: number | null;
  roomName?: string | null;
  displayName?: string | null;
  connectedAt?: number | null;
  allowGuestControl: boolean;
};

export type DiscoveredRoom = {
  name: string;
  host: string;
  port: number;
  passwordRequired: boolean;
  connectedUsers: number;
  maxUsers?: number | null;
  allowGuestControl: boolean;
  lastSeenAt: number;
};

export type RoomGuestTrack = {
  playback: RoomPlaybackState;
  path: string;
};
