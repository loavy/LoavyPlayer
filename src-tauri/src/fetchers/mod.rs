use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::models::FetcherDescriptor;

pub mod cover_art_archive;
pub mod musicbrainz;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FetcherCapability {
    AlbumArt,
    ArtistImage,
    Lyrics,
    AlbumInfo,
    ArtistBiography,
    GenreTags,
    SimilarArtists,
    MetadataCorrection,
}

impl FetcherCapability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AlbumArt => "albumArt",
            Self::ArtistImage => "artistImage",
            Self::Lyrics => "lyrics",
            Self::AlbumInfo => "albumInfo",
            Self::ArtistBiography => "artistBiography",
            Self::GenreTags => "genreTags",
            Self::SimilarArtists => "similarArtists",
            Self::MetadataCorrection => "metadataCorrection",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub capability: FetcherCapability,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub title: Option<String>,
    pub mbid: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FetchContext {
    #[allow(dead_code)]
    pub api_key: Option<String>,
    pub offline_mode: bool,
}

pub type FetchResult = anyhow::Result<Value>;

#[async_trait]
pub trait MetadataFetcher: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> &'static [FetcherCapability];
    fn requires_api_key(&self) -> bool;
    async fn fetch(&self, request: FetchRequest, ctx: FetchContext) -> FetchResult;
}

pub fn descriptors() -> Vec<FetcherDescriptor> {
    providers()
        .into_iter()
        .map(|provider| FetcherDescriptor {
            id: provider.id().to_string(),
            name: provider.name().to_string(),
            capabilities: provider
                .capabilities()
                .iter()
                .map(|capability| capability.as_str().to_string())
                .collect(),
            requires_api_key: provider.requires_api_key(),
        })
        .collect()
}

pub fn providers() -> Vec<Box<dyn MetadataFetcher>> {
    vec![
        Box::new(musicbrainz::MusicBrainzFetcher),
        Box::new(cover_art_archive::CoverArtArchiveFetcher),
    ]
}

pub async fn fetch_with_provider(
    provider_id: &str,
    request: FetchRequest,
    ctx: FetchContext,
) -> FetchResult {
    if ctx.offline_mode {
        return Ok(json!({ "offline": true, "items": [] }));
    }

    let Some(provider) = providers().into_iter().find(|provider| provider.id() == provider_id) else {
        anyhow::bail!("Unknown fetcher provider: {provider_id}");
    };

    provider.fetch(request, ctx).await
}
