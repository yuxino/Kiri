//! One bounded, resumable updater package. Only signed bytes leave this module.
use base64::Engine;
use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

pub fn client_builder() -> reqwest::ClientBuilder {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(60))
        .retry(reqwest::retry::never())
        .user_agent("Kiri-Updater")
}

#[derive(Serialize)]
pub struct Artifact<'a> {
    pub version: &'a str,
    pub target: &'a str,
    pub url: &'a str,
    pub signature: &'a str,
}

impl Artifact<'_> {
    pub fn key(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("artifact serialization"))
        )
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
        downloaded: u64,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadError {
    pub downloaded: u64,
    pub total: Option<u64>,
}

impl DownloadError {
    pub fn empty() -> Self {
        Self {
            downloaded: 0,
            total: None,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Partial {
    key: String,
    total: Option<u64>,
    validator: Option<String>,
    complete: bool,
}

struct Cache {
    directory: PathBuf,
    partial: Partial,
}

impl Cache {
    fn open(directory: &Path, key: String) -> anyhow::Result<Self> {
        fs::create_dir_all(directory)?;
        let mut cache = Self {
            directory: directory.to_owned(),
            partial: Partial::default(),
        };
        for path in [cache.package(), cache.metadata()] {
            if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
                anyhow::bail!("invalid updater cache file");
            }
        }
        cache.partial = fs::read(cache.metadata())
            .ok()
            .filter(|data| data.len() <= 8192)
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let length = cache.length();
        if cache.partial.key != key
            || length > MAX_PACKAGE_BYTES
            || cache
                .partial
                .total
                .is_some_and(|total| total > MAX_PACKAGE_BYTES || length > total)
        {
            cache.reset()?;
        }
        cache.partial.key = key;
        cache.save()?;
        Ok(cache)
    }

    fn package(&self) -> PathBuf {
        self.directory.join("package.part")
    }
    fn metadata(&self) -> PathBuf {
        self.directory.join("partial.json")
    }
    fn length(&self) -> u64 {
        fs::metadata(self.package())
            .map(|meta| meta.len())
            .unwrap_or(0)
    }

    fn save(&self) -> anyhow::Result<()> {
        // Metadata is replaced before any bytes of a new representation are appended.
        // An interrupted metadata write invalidates the cache on the next open.
        let mut file = fs::File::create(self.metadata())?;
        file.write_all(&serde_json::to_vec(&self.partial)?)?;
        file.sync_all()?;
        Ok(())
    }

    fn reset(&mut self) -> anyhow::Result<()> {
        fs::File::create(self.package())?.sync_all()?;
        self.partial.total = None;
        self.partial.validator = None;
        self.partial.complete = false;
        self.save()
    }

    fn failure(&self) -> DownloadError {
        DownloadError {
            downloaded: self.length(),
            total: self.partial.total,
        }
    }
}

pub fn clear_cache(directory: &Path) -> std::io::Result<()> {
    for name in ["partial.json", "package.part"] {
        match fs::remove_file(directory.join(name)) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

// Match the official updater's minisign verification, including legacy signatures.
// Its current install(bytes) API does not verify externally downloaded packages.
pub fn verify(bytes: &[u8], signature: &str, public_key: &str) -> anyhow::Result<()> {
    let decode = |value| -> anyhow::Result<String> {
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(value)?,
        )?)
    };
    let key = minisign_verify::PublicKey::decode(&decode(public_key)?)?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?)?;
    key.verify(bytes, &signature, true)?;
    Ok(())
}

pub async fn download(
    client: &Client,
    directory: &Path,
    artifact: &Artifact<'_>,
    public_key: &str,
    mut progress: impl FnMut(DownloadEvent),
) -> Result<Vec<u8>, DownloadError> {
    let mut cache = Cache::open(directory, artifact.key()).map_err(|_| DownloadError::empty())?;
    match receive(client, &mut cache, artifact, public_key, &mut progress).await {
        Ok(bytes) => Ok(bytes),
        Err(error) => {
            // No signed URLs, server bodies, or local paths in diagnostics.
            log::warn!(
                "[updates] download interrupted ({})",
                if error.is::<reqwest::Error>() {
                    "network"
                } else {
                    "package-or-cache"
                }
            );
            Err(cache.failure())
        }
    }
}

async fn receive(
    client: &Client,
    cache: &mut Cache,
    artifact: &Artifact<'_>,
    public_key: &str,
    progress: &mut impl FnMut(DownloadEvent),
) -> anyhow::Result<Vec<u8>> {
    let mut offset = cache.length();
    progress(DownloadEvent::Started {
        downloaded: offset,
        content_length: cache.partial.total,
    });
    if offset == 0 || !(cache.partial.complete || cache.partial.total == Some(offset)) {
        // A rejected range can recover once with a full request. No automatic
        // retry loop: network failures return to the explicit Resume action.
        for attempt in 0..2 {
            let mut request = client
                .get(artifact.url)
                .header(header::ACCEPT, "application/octet-stream")
                .header(header::ACCEPT_ENCODING, "identity");
            if offset > 0 {
                request = request.header(header::RANGE, format!("bytes={offset}-"));
                if let Some(validator) = &cache.partial.validator {
                    request = request.header(header::IF_RANGE, validator);
                }
            }
            let mut response = request.send().await?;
            if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 && attempt == 0
            {
                cache.reset()?;
                offset = 0;
                progress(DownloadEvent::Started {
                    downloaded: 0,
                    content_length: None,
                });
                continue;
            }
            let total = match response.status() {
                StatusCode::OK => {
                    // A server may ignore Range, or If-Range may identify a new
                    // representation. Never append its full body to old bytes.
                    if offset > 0 {
                        cache.reset()?;
                        offset = 0;
                    }
                    response.content_length()
                }
                StatusCode::PARTIAL_CONTENT if offset > 0 => {
                    let range = response
                        .headers()
                        .get(header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(parse_range);
                    match range {
                        Some((start, end, total))
                            if start == offset
                                && end == total - 1
                                && cache.partial.total.is_none_or(|previous| previous == total)
                                && response
                                    .content_length()
                                    .is_none_or(|length| length == total - start) =>
                        {
                            Some(total)
                        }
                        _ => {
                            cache.reset()?;
                            anyhow::bail!("invalid resume range");
                        }
                    }
                }
                _ => anyhow::bail!("unexpected download status"),
            };
            if total.is_some_and(|length| length == 0 || length > MAX_PACKAGE_BYTES) {
                cache.reset()?;
                anyhow::bail!("invalid package length");
            }
            cache.partial.total = total;
            cache.partial.complete = false;
            cache.partial.validator = response
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.starts_with("W/"))
                .or_else(|| {
                    response
                        .headers()
                        .get(header::LAST_MODIFIED)
                        .and_then(|value| value.to_str().ok())
                })
                .map(str::to_owned);
            cache.save()?;
            progress(DownloadEvent::Started {
                downloaded: offset,
                content_length: total,
            });
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(cache.package())?;
            while let Some(chunk) = response.chunk().await? {
                let next = offset
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| anyhow::anyhow!("package overflow"))?;
                if next > MAX_PACKAGE_BYTES || total.is_some_and(|total| next > total) {
                    drop(file);
                    cache.reset()?;
                    anyhow::bail!("oversized update package");
                }
                file.write_all(&chunk)?;
                offset = next;
                progress(DownloadEvent::Progress {
                    chunk_length: chunk.len(),
                });
            }
            file.sync_all()?;
            if offset == 0 || total.is_some_and(|total| offset != total) {
                anyhow::bail!("incomplete update package");
            }
            cache.partial.complete = true;
            cache.save()?;
            break;
        }
    }
    progress(DownloadEvent::Finished);
    let mut bytes = Vec::new();
    fs::File::open(cache.package())?
        .take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PACKAGE_BYTES
        || verify(&bytes, artifact.signature, public_key).is_err()
    {
        cache.reset()?;
        anyhow::bail!("update signature verification failed");
    }
    Ok(bytes)
}

fn parse_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

#[cfg(test)]
mod tests;
