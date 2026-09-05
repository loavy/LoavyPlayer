use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

const MAX_ART_BYTES: u64 = 12 * 1024 * 1024;

/// Keep an app-owned copy so moving the original picture cannot break a playlist.
pub async fn import_image(source: &Path, app_data: &Path) -> Result<PathBuf> {
    let metadata = tokio::fs::metadata(source)
        .await
        .context("Could not read the selected picture.")?;
    if !metadata.is_file() || metadata.len() > MAX_ART_BYTES {
        bail!("Choose a PNG, JPEG, or WebP picture smaller than 12 MB.");
    }
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(source).await?;
    let mut bytes = Vec::new();
    file.take(MAX_ART_BYTES + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > MAX_ART_BYTES {
        bail!("The selected picture is larger than 12 MB.");
    }
    let extension =
        image_extension(&bytes).context("Choose a valid PNG, JPEG, or WebP picture.")?;
    let directory = app_data.join("playlist-art");
    tokio::fs::create_dir_all(&directory).await?;
    let destination = directory.join(format!("{:x}.{extension}", Sha256::digest(&bytes)));
    if !destination.is_file() {
        tokio::fs::write(&destination, bytes)
            .await
            .context("Could not save the playlist picture.")?;
    }
    Ok(destination)
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn imported_art_survives_source_removal_and_rejects_invalid_files() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("loavy-art-{}-{nonce}", std::process::id()));
        let app_data = directory.join("app");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let source = directory.join("original.png");
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        tokio::fs::write(&source, bytes).await.unwrap();
        let imported = super::import_image(&source, &app_data).await.unwrap();
        assert!(imported.starts_with(app_data.join("playlist-art")));
        assert_eq!(
            super::import_image(&source, &app_data).await.unwrap(),
            imported
        );
        tokio::fs::remove_file(&source).await.unwrap();
        assert_eq!(tokio::fs::read(&imported).await.unwrap(), bytes);
        assert!(super::import_image(&source, &app_data).await.is_err());
        tokio::fs::write(&source, b"not a picture").await.unwrap();
        assert!(super::import_image(&source, &app_data).await.is_err());
        let oversized = tokio::fs::File::create(&source).await.unwrap();
        oversized.set_len(super::MAX_ART_BYTES + 1).await.unwrap();
        drop(oversized);
        assert!(super::import_image(&source, &app_data).await.is_err());
        assert!(super::import_image(&directory, &app_data).await.is_err());
        tokio::fs::remove_dir_all(&directory).await.unwrap();
    }

    #[test]
    fn detects_picture_content_instead_of_trusting_extensions() {
        assert_eq!(super::image_extension(b"\x89PNG\r\n\x1a\n"), Some("png"));
        assert_eq!(
            super::image_extension(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("jpg")
        );
        assert_eq!(super::image_extension(b"RIFF1234WEBP"), Some("webp"));
        assert_eq!(super::image_extension(b"<svg onload='alert(1)'>"), None);
        assert_eq!(super::image_extension(b"RIFF1234WAVE"), None);
    }
}
