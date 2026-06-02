use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{Album, Artist, MusicFolder, RoomPlaybackState, Track};

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS music_folders (
              id INTEGER PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL,
              last_scanned_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS tracks (
              id INTEGER PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_ext TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              title TEXT,
              artist TEXT,
              album TEXT,
              album_artist TEXT,
              genre TEXT,
              year INTEGER,
              track_number INTEGER,
              duration_ms INTEGER,
              cover_path TEXT,
              favorite INTEGER NOT NULL DEFAULT 0,
              date_added INTEGER NOT NULL,
              last_played_at INTEGER,
              play_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
            CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
            CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
            CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);

            CREATE TABLE IF NOT EXISTS playlists (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
              playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
              track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
              position INTEGER NOT NULL,
              PRIMARY KEY (playlist_id, track_id)
            );

            CREATE TABLE IF NOT EXISTS lyrics (
              track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
              plain_text TEXT,
              synced_text TEXT,
              source TEXT,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS api_keys (
              provider TEXT PRIMARY KEY,
              key_value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fetch_cache (
              provider TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_key TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              cached_at INTEGER NOT NULL,
              PRIMARY KEY (provider, entity_type, entity_key)
            );
            "#,
        )?;
        Ok(())
    }

    pub fn add_music_folder(&self, path: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO music_folders(path, enabled, created_at) VALUES (?1, 1, ?2)",
            params![path, now],
        )?;
        Ok(())
    }

    pub fn list_music_folders(&self) -> Result<Vec<MusicFolder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, enabled, created_at, last_scanned_at FROM music_folders ORDER BY path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(MusicFolder {
                id: row.get(0)?,
                path: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                created_at: row.get(3)?,
                last_scanned_at: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("list music folders")
    }

    pub fn mark_folder_scanned(&self, path: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE music_folders SET last_scanned_at = ?1 WHERE path = ?2",
            params![now, path],
        )?;
        Ok(())
    }

    pub fn upsert_track(&self, track: &Track) -> Result<()> {
        self.conn.execute(
            r#"
            INSERT INTO tracks (
              path, file_name, file_ext, file_size, modified_at, title, artist, album,
              album_artist, genre, year, track_number, duration_ms, cover_path, favorite,
              date_added, last_played_at, play_count
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            ON CONFLICT(path) DO UPDATE SET
              file_name = excluded.file_name,
              file_ext = excluded.file_ext,
              file_size = excluded.file_size,
              modified_at = excluded.modified_at,
              title = excluded.title,
              artist = excluded.artist,
              album = excluded.album,
              album_artist = excluded.album_artist,
              genre = excluded.genre,
              year = excluded.year,
              track_number = excluded.track_number,
              duration_ms = excluded.duration_ms,
              cover_path = excluded.cover_path
            "#,
            params![
                track.path,
                track.file_name,
                track.file_ext,
                track.file_size,
                track.modified_at,
                track.title,
                track.artist,
                track.album,
                track.album_artist,
                track.genre,
                track.year,
                track.track_number,
                track.duration_ms,
                track.cover_path,
                track.favorite as i64,
                track.date_added,
                track.last_played_at,
                track.play_count,
            ],
        )?;
        Ok(())
    }

    pub fn track_file_signature(&self, path: &str) -> Result<Option<(i64, i64)>> {
        self.conn
            .query_row(
                "SELECT file_size, modified_at FROM tracks WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .context("get track file signature")
    }

    pub fn remove_missing_tracks(&self) -> Result<usize> {
        let mut stmt = self.conn.prepare("SELECT path FROM tracks")?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut removed = 0;
        for path in paths {
            if !Path::new(&path).exists() {
                removed += self
                    .conn
                    .execute("DELETE FROM tracks WHERE path = ?1", params![path])?;
            }
        }
        Ok(removed)
    }

    pub fn list_tracks(&self, query: Option<&str>) -> Result<Vec<Track>> {
        let like = query.map(|q| format!("%{}%", q));
        let sql = if like.is_some() {
            r#"
            SELECT * FROM tracks
            WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1 OR genre LIKE ?1 OR file_name LIKE ?1
            ORDER BY COALESCE(artist, ''), COALESCE(album, ''), track_number, title, file_name
            "#
        } else {
            "SELECT * FROM tracks ORDER BY COALESCE(artist, ''), COALESCE(album, ''), track_number, title, file_name"
        };

        let mut stmt = self.conn.prepare(sql)?;
        let mapper = |row: &rusqlite::Row<'_>| {
            Ok(Track {
                id: row.get("id")?,
                path: row.get("path")?,
                file_name: row.get("file_name")?,
                file_ext: row.get("file_ext")?,
                file_size: row.get("file_size")?,
                modified_at: row.get("modified_at")?,
                title: row.get("title")?,
                artist: row.get("artist")?,
                album: row.get("album")?,
                album_artist: row.get("album_artist")?,
                genre: row.get("genre")?,
                year: row.get("year")?,
                track_number: row.get("track_number")?,
                duration_ms: row.get("duration_ms")?,
                cover_path: row.get("cover_path")?,
                favorite: row.get::<_, i64>("favorite")? != 0,
                date_added: row.get("date_added")?,
                last_played_at: row.get("last_played_at")?,
                play_count: row.get("play_count")?,
            })
        };

        if let Some(like) = like {
            let rows = stmt.query_map(params![like], mapper)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().context("list tracks")
        } else {
            let rows = stmt.query_map([], mapper)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().context("list tracks")
        }
    }

    pub fn set_track_favorite(&self, track_id: i64, favorite: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET favorite = ?1 WHERE id = ?2",
            params![favorite as i64, track_id],
        )?;
        Ok(())
    }

    pub fn find_track_for_room_playback(&self, playback: &RoomPlaybackState) -> Result<Option<Track>> {
        let title = playback.title.as_deref().unwrap_or_default();
        let artist = normalize_unknown(playback.artist.as_deref().unwrap_or_default());
        let album = normalize_unknown(playback.album.as_deref().unwrap_or_default());
        let duration = playback.duration_ms.unwrap_or_default();

        let sql = r#"
            SELECT * FROM tracks
            WHERE lower(COALESCE(NULLIF(title, ''), replace(file_name, '.' || file_ext, ''))) = lower(?1)
              AND (?2 = '' OR lower(COALESCE(artist, '')) = lower(?2))
            ORDER BY
              CASE WHEN ?3 != '' AND lower(COALESCE(album, '')) = lower(?3) THEN 0 ELSE 1 END,
              CASE WHEN ?4 > 0 AND duration_ms IS NOT NULL THEN abs(duration_ms - ?4) ELSE 0 END,
              title,
              file_name
            LIMIT 1
        "#;

        let mut stmt = self.conn.prepare(sql)?;
        stmt.query_row(params![title, artist, album, duration], |row| row_to_track(row))
            .optional()
            .context("find room playback track")
    }

    pub fn list_albums(&self) -> Result<Vec<Album>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              COALESCE(album, 'Unknown Album') AS title,
              album_artist,
              MIN(year) AS year,
              MAX(cover_path) AS cover_path,
              COUNT(*) AS track_count
            FROM tracks
            GROUP BY COALESCE(album, 'Unknown Album'), album_artist
            ORDER BY title
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Album {
                title: row.get(0)?,
                artist: row.get(1)?,
                year: row.get(2)?,
                cover_path: row.get(3)?,
                track_count: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("list albums")
    }

    pub fn list_artists(&self) -> Result<Vec<Artist>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT
              COALESCE(NULLIF(artist, ''), 'Unknown Artist') AS name,
              COUNT(*) AS track_count,
              COUNT(DISTINCT album) AS album_count
            FROM tracks
            GROUP BY COALESCE(NULLIF(artist, ''), 'Unknown Artist')
            ORDER BY name
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Artist {
                name: row.get(0)?,
                track_count: row.get(1)?,
                album_count: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("list artists")
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0))
            .optional()
            .context("get setting")
    }

    pub fn set_api_key(&self, provider: &str, key_value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO api_keys(provider, key_value) VALUES (?1, ?2) ON CONFLICT(provider) DO UPDATE SET key_value = excluded.key_value",
            params![provider, key_value],
        )?;
        Ok(())
    }
}

fn normalize_unknown(value: &str) -> &str {
    if value.eq_ignore_ascii_case("unknown artist") || value.eq_ignore_ascii_case("unknown album") {
        ""
    } else {
        value
    }
}

fn row_to_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        path: row.get("path")?,
        file_name: row.get("file_name")?,
        file_ext: row.get("file_ext")?,
        file_size: row.get("file_size")?,
        modified_at: row.get("modified_at")?,
        title: row.get("title")?,
        artist: row.get("artist")?,
        album: row.get("album")?,
        album_artist: row.get("album_artist")?,
        genre: row.get("genre")?,
        year: row.get("year")?,
        track_number: row.get("track_number")?,
        duration_ms: row.get("duration_ms")?,
        cover_path: row.get("cover_path")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        date_added: row.get("date_added")?,
        last_played_at: row.get("last_played_at")?,
        play_count: row.get("play_count")?,
    })
}
