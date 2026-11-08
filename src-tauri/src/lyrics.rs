use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    models::{TrackLyrics, TrackLyricsUpdate},
    state::AppState,
};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const API_URL: &str = "https://lrclib.net/api/search";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsMatch {
    pub id: i64,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

fn has_text(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|text| !text.trim().is_empty())
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn exact_match(item: &LyricsMatch, title: &str, artist: &str, duration: Option<i64>) -> bool {
    normalized(item.track_name.as_deref().unwrap_or_default()) == normalized(title)
        && normalized(item.artist_name.as_deref().unwrap_or_default()) == normalized(artist)
        && matches!((item.duration, duration), (Some(a), Some(b)) if a.is_finite() && b > 0 && (a - b as f64 / 1000.0).abs() <= 2.0)
}

fn ensure_online(state: &AppState) -> Result<(), String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    if db
        .get_setting("offlineMode")
        .map_err(|error| error.to_string())?
        .as_deref()
        == Some("true")
    {
        return Err("Offline mode is on. Turn it off in Settings to search online. Saved lyrics still work offline.".into());
    }
    Ok(())
}

async fn request_matches(url: &str, params: &[(&str, &str)]) -> Result<Vec<LyricsMatch>, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "LoavyPlayer/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/loavy/LoavyPlayer)"
        ))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not initialize online lyric search.".to_string())?;
    let mut response = client
        .get(url)
        .query(params)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Lyric search timed out. Try again in a moment.".to_string()
            } else {
                "Could not reach LRCLIB. Check your internet connection and try again.".to_string()
            }
        })?;
    match response.status() {
        StatusCode::NOT_FOUND => return Ok(Vec::new()),
        StatusCode::TOO_MANY_REQUESTS => {
            return Err("LRCLIB is busy. Please wait a minute before searching again.".into())
        }
        status if !status.is_success() => {
            return Err(format!(
                "LRCLIB is unavailable (HTTP {}). Try again later.",
                status.as_u16()
            ))
        }
        _ => {}
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The lyric response was interrupted. Try again.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("The lyric response is too large. Try a more specific search.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut matches: Vec<LyricsMatch> = serde_json::from_slice(&bytes)
        .map_err(|_| "LRCLIB returned an unreadable response. Try again later.".to_string())?;
    matches.retain(|item| {
        item.id > 0
            && (item.instrumental || has_text(&item.plain_lyrics) || has_text(&item.synced_lyrics))
    });
    Ok(matches)
}

#[tauri::command]
pub async fn search_online_lyrics(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<LyricsMatch>, String> {
    ensure_online(&state)?;
    let query = query.trim();
    if query.chars().count() < 2 || query.chars().count() > 240 {
        return Err("Search with 2–240 characters, such as a song title and artist.".into());
    }
    let mut matches = request_matches(API_URL, &[("q", query)]).await?;
    matches.sort_by_key(|item| !has_text(&item.synced_lyrics));
    matches.truncate(30);
    Ok(matches)
}

#[tauri::command]
pub async fn lookup_online_lyrics(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<Option<TrackLyrics>, String> {
    let track = {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        if let Some(saved) = db
            .get_track_lyrics(track_id)
            .map_err(|error| error.to_string())?
        {
            return Ok(Some(saved));
        }
        if db
            .get_setting(&format!("lyricsSuppressed:{track_id}"))
            .map_err(|error| error.to_string())?
            .as_deref()
            == Some("true")
        {
            return Ok(None);
        }
        if db
            .get_setting("lyricsAutoSearch")
            .map_err(|error| error.to_string())?
            .as_deref()
            == Some("false")
        {
            return Ok(None);
        }
        db.track_by_id(track_id)
            .map_err(|error| error.to_string())?
    };
    ensure_online(&state)?;
    let title = track.title.as_deref().unwrap_or_default().trim();
    let artist = track.artist.as_deref().unwrap_or_default().trim();
    if title.is_empty()
        || artist.is_empty()
        || artist.eq_ignore_ascii_case("unknown artist")
        || track.duration_ms.unwrap_or_default() <= 0
    {
        return Ok(None);
    }
    let mut matches =
        request_matches(API_URL, &[("track_name", title), ("artist_name", artist)]).await?;
    matches.retain(|item| exact_match(item, title, artist, track.duration_ms));
    matches.sort_by_key(|item| {
        (
            !has_text(&item.synced_lyrics),
            normalized(item.album_name.as_deref().unwrap_or_default())
                != normalized(track.album.as_deref().unwrap_or_default()),
        )
    });
    let Some(found) = matches.into_iter().next() else {
        return Ok(None);
    };
    let db = state.db.lock().map_err(|error| error.to_string())?;
    // An edit or import made while the network request was running always wins.
    if let Some(saved) = db
        .get_track_lyrics(track_id)
        .map_err(|error| error.to_string())?
    {
        return Ok(Some(saved));
    }
    if db
        .get_setting(&format!("lyricsSuppressed:{track_id}"))
        .map_err(|error| error.to_string())?
        .as_deref()
        == Some("true")
    {
        return Ok(None);
    }
    if db
        .get_setting("lyricsAutoSearch")
        .map_err(|error| error.to_string())?
        .as_deref()
        == Some("false")
        || db
            .get_setting("offlineMode")
            .map_err(|error| error.to_string())?
            .as_deref()
            == Some("true")
    {
        return Ok(None);
    }
    db.save_track_lyrics(
        TrackLyricsUpdate {
            track_id,
            plain_text: if found.instrumental {
                Some("[Instrumental]".into())
            } else {
                found.plain_lyrics
            },
            synced_text: found.synced_lyrics,
            source: Some(format!("lrclib:{}", found.id)),
        },
        chrono::Utc::now().timestamp_millis(),
    )
    .map(Some)
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_track_lyrics(
    state: State<'_, AppState>,
    track_id: i64,
    format: String,
) -> Result<Option<String>, String> {
    let (lyrics, track) = {
        let db = state.db.lock().map_err(|error| error.to_string())?;
        (
            db.get_track_lyrics(track_id)
                .map_err(|error| error.to_string())?
                .ok_or("Save lyrics before downloading them.")?,
            db.track_by_id(track_id)
                .map_err(|error| error.to_string())?,
        )
    };
    let text = match format.as_str() {
        "lrc" => lyrics
            .synced_text
            .filter(|text| !text.trim().is_empty())
            .ok_or("This version has no timestamps. Download TXT or add timing in the editor.")?,
        "txt" => lyrics
            .plain_text
            .filter(|text| !text.trim().is_empty())
            .map(|text| crate::commands::strip_word_timestamps(&text))
            .or_else(|| {
                lyrics
                    .synced_text
                    .map(|text| crate::commands::plain_text_from_lrc(&text))
            })
            .ok_or("No lyrics to download.")?,
        _ => return Err("Choose LRC or TXT format.".into()),
    };
    let stem = std::path::Path::new(&track.file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("lyrics");
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Download lyrics")
        .set_file_name(format!("{stem}.{format}"))
        .add_filter("Lyrics", &[&format])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    // Restrict exports to lyric files so an accidental selection cannot replace audio.
    if !file
        .path()
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(&format))
    {
        return Err(format!("Choose a file ending in .{format}."));
    }
    tokio::fs::write(file.path(), text.replace("\r\n", "\n"))
        .await
        .map_err(|error| format!("Could not save lyrics: {error}"))?;
    Ok(Some(file.path().to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires an internet connection to LRCLIB"]
    async fn live_lrclib_search_returns_usable_lyrics() {
        let results = request_matches(
            API_URL,
            &[("track_name", "Yellow"), ("artist_name", "Coldplay")],
        )
        .await
        .unwrap();
        assert!(results.iter().any(|item| has_text(&item.synced_lyrics)));
        // Verify metadata only; never print or snapshot third-party lyric text.
        assert!(results
            .iter()
            .any(|item| normalized(item.artist_name.as_deref().unwrap_or_default()) == "coldplay"));
    }

    fn candidate() -> LyricsMatch {
        LyricsMatch {
            id: 1,
            track_name: Some("Test Song".into()),
            artist_name: Some("An Artist".into()),
            album_name: None,
            duration: Some(180.0),
            instrumental: false,
            plain_lyrics: Some("Original test verse".into()),
            synced_lyrics: None,
        }
    }

    #[test]
    fn automatic_matches_require_artist_title_and_close_duration() {
        let item = candidate();
        assert!(exact_match(
            &item,
            " test song ",
            "AN  ARTIST",
            Some(181900)
        ));
        assert!(!exact_match(
            &item,
            "Test Song (Live)",
            "An Artist",
            Some(180000)
        ));
        assert!(!exact_match(
            &item,
            "Test Song",
            "Another Artist",
            Some(180000)
        ));
        assert!(!exact_match(&item, "Test Song", "An Artist", Some(183000)));
        assert!(!exact_match(&item, "Test Song", "An Artist", None));
    }

    #[tokio::test]
    async fn provider_handles_results_errors_and_malformed_responses() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for (status, body, expected) in [
            ("200 OK", "[]", "ok"),
            ("404 Not Found", "", "ok"),
            ("429 Too Many Requests", "", "busy"),
            ("503 Unavailable", "", "503"),
            ("200 OK", "not json", "unreadable"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/search", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                stream.read(&mut request).await.unwrap();
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let result = request_matches(&url, &[("q", "test & song")]).await;
            if expected == "ok" {
                assert!(result.unwrap().is_empty());
            } else {
                assert!(result.unwrap_err().contains(expected));
            }
            server.await.unwrap();
        }
    }
}
