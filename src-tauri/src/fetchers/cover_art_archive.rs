use async_trait::async_trait;
use serde_json::{json, Value};

use super::{FetchContext, FetchRequest, FetchResult, FetcherCapability, MetadataFetcher};

pub struct CoverArtArchiveFetcher;

#[async_trait]
impl MetadataFetcher for CoverArtArchiveFetcher {
    fn id(&self) -> &'static str {
        "cover-art-archive"
    }

    fn name(&self) -> &'static str {
        "Cover Art Archive"
    }

    fn capabilities(&self) -> &'static [FetcherCapability] {
        &[FetcherCapability::AlbumArt]
    }

    fn requires_api_key(&self) -> bool {
        false
    }

    async fn fetch(&self, request: FetchRequest, _ctx: FetchContext) -> FetchResult {
        let Some(mbid) = request.mbid else {
            anyhow::bail!("Cover Art Archive requires a MusicBrainz release MBID");
        };

        let client = reqwest::Client::builder()
            .user_agent("LoavyPlayer/0.1.0 (local desktop music player)")
            .build()?;
        let value: Value = client
            .get(format!("https://coverartarchive.org/release/{mbid}"))
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

