use std::{collections::HashSet, path::Path, time::Duration};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::models::{
    Album, Artist, MusicFolder, Playlist, RoomPlaybackState, Track, TrackLyrics, TrackLyricsUpdate,
    TrackPlaybackStats,
};

const DATABASE_SCHEMA_VERSION: i64 = 2;
const MAX_PLAYLIST_NAME_CHARS: usize = 120;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            "#,
        )?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<()> {
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            r#"
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
              added_at INTEGER NOT NULL DEFAULT 0,
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

        // Deployed Loavy databases and databases created from this source tree do
        // not all share the same user_version. Inspect the actual table so this
        // migration remains safe for both, and never rebuild the lyrics table:
        // deployed builds may contain additional lyrics provenance/offset fields.
        if !table_has_column(&transaction, "playlist_tracks", "added_at")? {
            transaction.execute_batch(
                "ALTER TABLE playlist_tracks ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        transaction.execute(
            r#"
            UPDATE playlist_tracks
            SET added_at = COALESCE(
              (SELECT created_at FROM playlists WHERE playlists.id = playlist_tracks.playlist_id),
              0
            )
            WHERE added_at = 0
            "#,
            [],
        )?;
        transaction.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position
              ON playlist_tracks(playlist_id, position);
            "#,
        )?;
        let current_version: i64 =
            transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < DATABASE_SCHEMA_VERSION {
            transaction.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)?;
        }
        transaction.commit()?;
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("list music folders")
    }

    pub fn music_folder(&self, folder_id: i64) -> Result<MusicFolder> {
        self.conn
            .query_row(
                "SELECT id, path, enabled, created_at, last_scanned_at FROM music_folders WHERE id = ?1",
                params![folder_id],
                |row| {
                    Ok(MusicFolder {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        enabled: row.get::<_, i64>(2)? != 0,
                        created_at: row.get(3)?,
                        last_scanned_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .context("Music folder was not found.")
    }

    pub fn remove_music_folder(&self, folder_id: i64) -> Result<()> {
        let path = self
            .conn
            .query_row(
                "SELECT path FROM music_folders WHERE id = ?1",
                params![folder_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .context("music folder not found")?;
        let prefix = if path.ends_with(std::path::MAIN_SEPARATOR) {
            path.clone()
        } else {
            format!("{}{}", path, std::path::MAIN_SEPARATOR)
        };

        self.conn.execute(
            "DELETE FROM music_folders WHERE id = ?1",
            params![folder_id],
        )?;
        self.conn.execute(
            "DELETE FROM tracks WHERE path = ?1 OR path LIKE ?2",
            params![path, format!("{prefix}%")],
        )?;
        Ok(())
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

    pub fn track_path(&self, track_id: i64) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT path FROM tracks WHERE id = ?1",
                params![track_id],
                |row| row.get(0),
            )
            .optional()
            .context("get track path")
    }

    pub fn track_by_id(&self, track_id: i64) -> Result<Track> {
        self.conn
            .query_row(
                "SELECT * FROM tracks WHERE id = ?1",
                params![track_id],
                row_to_track,
            )
            .optional()?
            .context("Track was not found.")
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
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("list tracks")
        } else {
            let rows = stmt.query_map([], mapper)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("list tracks")
        }
    }

    pub fn set_track_favorite(&self, track_id: i64, favorite: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET favorite = ?1 WHERE id = ?2",
            params![favorite as i64, track_id],
        )?;
        Ok(())
    }

    pub fn find_track_for_room_playback(
        &self,
        playback: &RoomPlaybackState,
    ) -> Result<Option<Track>> {
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
        stmt.query_row(params![title, artist, album, duration], |row| {
            row_to_track(row)
        })
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("list albums")
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("list artists")
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
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
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

    pub fn list_playlists(&self) -> Result<Vec<Playlist>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(pt.track_id) AS track_count
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
            GROUP BY p.id, p.name, p.created_at, p.updated_at
            ORDER BY p.updated_at DESC, p.name
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                track_count: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("list playlists")
    }

    pub fn create_playlist(&self, name: &str, now: i64) -> Result<Playlist> {
        let name = validate_playlist_name(name)?;
        let transaction = self.conn.unchecked_transaction()?;
        if playlist_name_exists(&transaction, &name, None)? {
            bail!("A playlist named \"{name}\" already exists.");
        }
        transaction.execute(
            "INSERT INTO playlists(name, created_at, updated_at) VALUES (?1, ?2, ?2)",
            params![name, now],
        )?;
        let id = transaction.last_insert_rowid();
        transaction.commit()?;
        Ok(Playlist {
            id,
            name,
            created_at: now,
            updated_at: now,
            track_count: 0,
        })
    }

    pub fn rename_playlist(&self, playlist_id: i64, name: &str, now: i64) -> Result<Playlist> {
        let name = validate_playlist_name(name)?;
        let transaction = self.conn.unchecked_transaction()?;
        ensure_playlist_exists(&transaction, playlist_id)?;
        if playlist_name_exists(&transaction, &name, Some(playlist_id))? {
            bail!("A playlist named \"{name}\" already exists.");
        }
        transaction.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, playlist_id],
        )?;
        let playlist = playlist_by_id(&transaction, playlist_id)?;
        transaction.commit()?;
        Ok(playlist)
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed =
            transaction.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
        if changed == 0 {
            bail!("Playlist was not found.");
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn add_track_to_playlist(&self, playlist_id: i64, track_id: i64) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        ensure_playlist_exists(&transaction, playlist_id)?;
        ensure_track_exists(&transaction, track_id)?;
        let already_present = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2)",
            params![playlist_id, track_id],
            |row| row.get::<_, bool>(0),
        )?;
        if already_present {
            bail!("Track is already in this playlist.");
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )?;
        let now = chrono::Utc::now().timestamp_millis();
        transaction.execute(
            "INSERT INTO playlist_tracks(playlist_id, track_id, position, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![playlist_id, track_id, position, now],
        )?;
        transaction.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_track_from_playlist(&self, playlist_id: i64, track_id: i64) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        ensure_playlist_exists(&transaction, playlist_id)?;
        let position = transaction
            .query_row(
                "SELECT position FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
                params![playlist_id, track_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .context("Track is not in this playlist.")?;
        transaction.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        transaction.execute(
            "UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ?1 AND position > ?2",
            params![playlist_id, position],
        )?;
        transaction.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp_millis(), playlist_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reorder_playlist_tracks(&self, playlist_id: i64, track_ids: &[i64]) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        ensure_playlist_exists(&transaction, playlist_id)?;
        let current = {
            let mut statement = transaction.prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, track_id",
            )?;
            let rows = statement
                .query_map(params![playlist_id], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let requested = track_ids.iter().copied().collect::<HashSet<_>>();
        if requested.len() != track_ids.len() {
            bail!("Playlist order contains duplicate track IDs.");
        }
        let existing = current.iter().copied().collect::<HashSet<_>>();
        if current.len() != track_ids.len() || existing != requested {
            bail!("Playlist order must contain every current track exactly once.");
        }
        if current != track_ids {
            {
                let mut statement = transaction.prepare(
                    "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
                )?;
                for (position, track_id) in track_ids.iter().enumerate() {
                    statement.execute(params![position as i64, playlist_id, track_id])?;
                }
            }
            transaction.execute(
                "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
                params![chrono::Utc::now().timestamp_millis(), playlist_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_playlist_tracks(&self, playlist_id: i64) -> Result<Vec<Track>> {
        let exists = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM playlists WHERE id = ?1)",
            params![playlist_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            bail!("Playlist was not found.");
        }
        let mut stmt = self.conn.prepare(
            r#"
            SELECT t.*
            FROM playlist_tracks pt
            JOIN tracks t ON t.id = pt.track_id
            WHERE pt.playlist_id = ?1
            ORDER BY pt.position
            "#,
        )?;
        let rows = stmt.query_map(params![playlist_id], row_to_track)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("list playlist tracks")
    }

    pub fn get_track_lyrics(&self, track_id: i64) -> Result<Option<TrackLyrics>> {
        self.conn
            .query_row(
                "SELECT track_id, plain_text, synced_text, source, updated_at FROM lyrics WHERE track_id = ?1",
                params![track_id],
                |row| {
                    Ok(TrackLyrics {
                        track_id: row.get(0)?,
                        plain_text: row.get(1)?,
                        synced_text: row.get(2)?,
                        source: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .context("get track lyrics")
    }

    pub fn save_track_lyrics(&self, update: TrackLyricsUpdate, now: i64) -> Result<TrackLyrics> {
        let plain_text = normalize_optional_text(update.plain_text);
        let synced_text = normalize_optional_text(update.synced_text);
        if plain_text.is_none() && synced_text.is_none() {
            bail!("Lyrics text is required.");
        }
        let source = normalize_lyrics_source(update.source)?;
        let transaction = self.conn.unchecked_transaction()?;
        ensure_track_exists(&transaction, update.track_id)?;
        transaction.execute(
            r#"
            INSERT INTO lyrics(track_id, plain_text, synced_text, source, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(track_id) DO UPDATE SET
              plain_text = excluded.plain_text,
              synced_text = excluded.synced_text,
              source = excluded.source,
              updated_at = excluded.updated_at
            "#,
            params![update.track_id, plain_text, synced_text, source, now],
        )?;
        let lyrics = transaction.query_row(
            "SELECT track_id, plain_text, synced_text, source, updated_at FROM lyrics WHERE track_id = ?1",
            params![update.track_id],
            |row| {
                Ok(TrackLyrics {
                    track_id: row.get(0)?,
                    plain_text: row.get(1)?,
                    synced_text: row.get(2)?,
                    source: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )?;
        transaction.commit()?;
        Ok(lyrics)
    }

    pub fn delete_track_lyrics(&self, track_id: i64) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM lyrics WHERE track_id = ?1", params![track_id])?;
        if changed == 0 {
            bail!("Lyrics were not found for this track.");
        }
        Ok(())
    }

    pub fn mark_track_played(&self, track_id: i64, now: i64) -> Result<TrackPlaybackStats> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE tracks SET last_played_at = ?1, play_count = play_count + 1 WHERE id = ?2",
            params![now, track_id],
        )?;
        if changed == 0 {
            bail!("Track was not found.");
        }
        let play_count = transaction.query_row(
            "SELECT play_count FROM tracks WHERE id = ?1",
            params![track_id],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(TrackPlaybackStats {
            track_id,
            last_played_at: now,
            play_count,
        })
    }

    pub fn rewrite_track_paths(&self, updates: &[(i64, String)]) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare("UPDATE tracks SET path = ?1 WHERE id = ?2")?;
            for (track_id, path) in updates {
                if statement.execute(params![path, track_id])? != 1 {
                    bail!("An indexed track disappeared while renaming its folder.");
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_track_records(&self, track_ids: &[i64]) -> Result<Vec<Option<String>>> {
        let transaction = self.conn.unchecked_transaction()?;
        let mut covers = Vec::with_capacity(track_ids.len());
        for track_id in track_ids {
            let cover = transaction
                .query_row(
                    "SELECT cover_path FROM tracks WHERE id = ?1",
                    params![track_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .context("An indexed track was not found.")?;
            transaction.execute("DELETE FROM tracks WHERE id = ?1", params![track_id])?;
            covers.push(cover);
        }
        transaction.commit()?;
        Ok(covers)
    }

    pub fn cover_reference_count(&self, cover_path: &str) -> Result<i64> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE cover_path = ?1",
                params![cover_path],
                |row| row.get(0),
            )
            .context("count cover references")
    }
}

fn table_has_column(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
) -> Result<bool> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns.iter().any(|candidate| candidate == column))
}

fn validate_playlist_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("Playlist name is required.");
    }
    if value.chars().count() > MAX_PLAYLIST_NAME_CHARS {
        bail!("Playlist name cannot exceed {MAX_PLAYLIST_NAME_CHARS} characters.");
    }
    if value.chars().any(char::is_control) {
        bail!("Playlist name cannot contain control characters.");
    }
    Ok(value.to_string())
}

fn playlist_name_exists(
    transaction: &rusqlite::Transaction<'_>,
    name: &str,
    excluding_id: Option<i64>,
) -> Result<bool> {
    let mut statement = transaction.prepare("SELECT id, name FROM playlists")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let normalized = name.to_lowercase();
    for row in rows {
        let (id, candidate) = row?;
        if Some(id) != excluding_id && candidate.to_lowercase() == normalized {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_playlist_exists(transaction: &rusqlite::Transaction<'_>, playlist_id: i64) -> Result<()> {
    let exists = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM playlists WHERE id = ?1)",
        params![playlist_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        bail!("Playlist was not found.");
    }
    Ok(())
}

fn ensure_track_exists(transaction: &rusqlite::Transaction<'_>, track_id: i64) -> Result<()> {
    let exists = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1)",
        params![track_id],
        |row| row.get::<_, bool>(0),
    )?;
    if !exists {
        bail!("Track was not found.");
    }
    Ok(())
}

fn playlist_by_id(transaction: &rusqlite::Transaction<'_>, playlist_id: i64) -> Result<Playlist> {
    transaction
        .query_row(
            r#"
            SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(pt.track_id)
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
            WHERE p.id = ?1
            GROUP BY p.id, p.name, p.created_at, p.updated_at
            "#,
            params![playlist_id],
            |row| {
                Ok(Playlist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    track_count: row.get(4)?,
                })
            },
        )
        .optional()?
        .context("Playlist was not found.")
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim_start_matches('\u{feff}').trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn normalize_lyrics_source(value: Option<String>) -> Result<Option<String>> {
    let source = value.unwrap_or_else(|| "manual".to_string());
    let source = source.trim();
    if source.is_empty() {
        return Ok(Some("manual".to_string()));
    }
    if source.chars().count() > 160 || source.chars().any(char::is_control) {
        bail!("Lyrics source is invalid.");
    }
    Ok(Some(source.to_string()))
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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rusqlite::{params, Connection};

    use super::Database;
    use crate::models::{Track, TrackLyricsUpdate};

    fn temporary_database(name: &str) -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("loavy-db-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let database = directory.join("test.sqlite3");
        (directory, database)
    }

    fn add_track(db: &Database, path: &Path, title: &str) -> i64 {
        db.upsert_track(&Track {
            id: 0,
            path: path.to_string_lossy().to_string(),
            file_name: format!("{title}.mp3"),
            file_ext: "mp3".to_string(),
            file_size: 123,
            modified_at: 456,
            title: Some(title.to_string()),
            artist: Some("Artist".to_string()),
            album: Some("Album".to_string()),
            album_artist: Some("Artist".to_string()),
            genre: None,
            year: Some(2026),
            track_number: None,
            duration_ms: Some(60_000),
            cover_path: None,
            favorite: false,
            date_added: 1,
            last_played_at: None,
            play_count: 0,
        })
        .unwrap();
        db.list_tracks(None)
            .unwrap()
            .into_iter()
            .find(|track| track.path == path.to_string_lossy())
            .unwrap()
            .id
    }

    #[test]
    fn migration_adds_playlist_timestamp_without_rebuilding_deployed_lyrics() {
        let (directory, path) = temporary_database("migration");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    r#"
                    PRAGMA user_version = 1;
                    CREATE TABLE playlists (
                      id INTEGER PRIMARY KEY,
                      name TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL
                    );
                    CREATE TABLE playlist_tracks (
                      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                      track_id INTEGER NOT NULL,
                      position INTEGER NOT NULL,
                      PRIMARY KEY (playlist_id, track_id)
                    );
                    CREATE TABLE lyrics (
                      track_id INTEGER PRIMARY KEY,
                      plain_text TEXT,
                      synced_text TEXT,
                      source TEXT,
                      deployed_marker TEXT,
                      updated_at INTEGER NOT NULL
                    );
                    INSERT INTO playlists(id, name, created_at, updated_at)
                    VALUES (1, 'Migrated', 1234, 1234);
                    INSERT INTO playlist_tracks(playlist_id, track_id, position)
                    VALUES (1, 99, 0);
                    "#,
                )
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let playlist_columns = {
            let mut statement = db
                .conn
                .prepare("PRAGMA table_info(playlist_tracks)")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let lyrics_columns = {
            let mut statement = db.conn.prepare("PRAGMA table_info(lyrics)").unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert!(playlist_columns.iter().any(|column| column == "added_at"));
        assert!(lyrics_columns
            .iter()
            .any(|column| column == "deployed_marker"));
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT added_at FROM playlist_tracks WHERE playlist_id = 1 AND track_id = 99",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1234
        );
        assert_eq!(
            db.conn
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn playlist_mutations_validate_duplicates_and_preserve_manual_order() {
        let (directory, path) = temporary_database("playlists");
        let db = Database::open(&path).unwrap();
        let first = add_track(&db, &directory.join("one.mp3"), "One");
        let second = add_track(&db, &directory.join("two.mp3"), "Two");
        let third = add_track(&db, &directory.join("three.mp3"), "Three");
        let playlist = db.create_playlist("Road trip", 10).unwrap();
        assert!(db.create_playlist(" road TRIP ", 11).is_err());
        db.add_track_to_playlist(playlist.id, first).unwrap();
        db.add_track_to_playlist(playlist.id, second).unwrap();
        db.add_track_to_playlist(playlist.id, third).unwrap();
        assert!(db.add_track_to_playlist(playlist.id, first).is_err());
        db.reorder_playlist_tracks(playlist.id, &[third, first, second])
            .unwrap();
        let ordered = db
            .list_playlist_tracks(playlist.id)
            .unwrap()
            .into_iter()
            .map(|track| track.id)
            .collect::<Vec<_>>();
        assert_eq!(ordered, vec![third, first, second]);
        assert!(db
            .reorder_playlist_tracks(playlist.id, &[third, third, first])
            .is_err());
        db.remove_track_from_playlist(playlist.id, first).unwrap();
        let positions = {
            let mut statement = db
                .conn
                .prepare(
                    "SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
                )
                .unwrap();
            statement
                .query_map(params![playlist.id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(positions, vec![(third, 0), (second, 1)]);
        db.delete_playlist(playlist.id).unwrap();
        assert!(db.list_playlist_tracks(playlist.id).is_err());
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lyrics_upsert_preserves_unknown_deployed_columns() {
        let (directory, path) = temporary_database("lyrics");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    r#"
                    CREATE TABLE lyrics (
                      track_id INTEGER PRIMARY KEY,
                      plain_text TEXT,
                      synced_text TEXT,
                      source TEXT,
                      deployed_marker TEXT,
                      updated_at INTEGER NOT NULL
                    );
                    "#,
                )
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let track_id = add_track(&db, &directory.join("lyrics.mp3"), "Lyrics");
        db.conn
            .execute(
                "INSERT INTO lyrics(track_id, plain_text, source, deployed_marker, updated_at) VALUES (?1, 'old', 'download', 'keep-me', 1)",
                params![track_id],
            )
            .unwrap();
        let saved = db
            .save_track_lyrics(
                TrackLyricsUpdate {
                    track_id,
                    plain_text: Some("new text".to_string()),
                    synced_text: None,
                    source: Some("manual".to_string()),
                },
                2,
            )
            .unwrap();
        assert_eq!(saved.plain_text.as_deref(), Some("new text"));
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT deployed_marker FROM lyrics WHERE track_id = ?1",
                    params![track_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "keep-me"
        );
        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }
}
