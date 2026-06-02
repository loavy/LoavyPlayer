use async_trait::async_trait;
use serde_json::{json, Value};

use super::{FetchContext, FetchRequest, FetchResult, FetcherCapability, MetadataFetcher};

pub struct MusicBrainzFetcher;

#[async_trait]
impl MetadataFetcher for MusicBrainzFetcher {
    fn id(&self) -> &'static str {
        "musicbrainz"
    }

    fn name(&self) -> &'static str {
        "MusicBrainz"
    }

    fn capabilities(&self) -> &'static [FetcherCapability] {
        &[
            FetcherCapability::AlbumInfo,
            FetcherCapability::GenreTags,
            FetcherCapability::MetadataCorrection,
        ]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    async fn fetch(&self, request: FetchRequest, _ctx: FetchContext) -> FetchResult {
        let client = reqwest::Client::builder()
            .user_agent("LoavyPlayer/0.1.0 (local desktop music player)")
            .build()?;

        let mut params = Vec::new();
        if let Some(artist) = request.artist {
            params.push(format!("artist:\"{artist}\""));
        }
        if let Some(album) = request.album {
            params.push(format!("release:\"{album}\""));
        }
        if let Some(title) = request.title {
            params.push(format!("recording:\"{title}\""));
        }

        let query = if params.is_empty() {
            "*".to_string()
        } else {
            params.join(" AND ")
        };

        let value: Value = client
            .get("https://musicbrainz.org/ws/2/release/")
            .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "8")])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        Ok(json!({
            "provider": self.id(),
            "capability": request.capability,
            "raw": value
        }))
    }
}

