//! A bounded PNG snapshot and the library version it was read from.

use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::core::asset::{CaptureAsset, CaptureKind};
use crate::core::library::AssetLibrary;
use crate::core::library_location::LibraryContext;

pub(crate) const MAX_PREPARED_PNG_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const SOURCE_CHANGED: &str = "The image or text record changed. Try again.";

#[derive(Clone, Copy)]
pub(crate) struct OcrImageVersion {
    pub(crate) id: uuid::Uuid,
    pub(crate) revision: Option<uuid::Uuid>,
    library_id: uuid::Uuid,
    library_generation: uuid::Uuid,
}

impl OcrImageVersion {
    pub(crate) fn new(
        context: &LibraryContext,
        id: uuid::Uuid,
        revision: Option<uuid::Uuid>,
    ) -> Self {
        Self {
            id,
            revision,
            library_id: context.expected_library_id(),
            library_generation: context.expected_library_generation(),
        }
    }

    pub(crate) fn matches_library(&self, context: &LibraryContext) -> bool {
        context.expected_library_id() == self.library_id
            && context.expected_library_generation() == self.library_generation
    }

    pub(crate) fn active_image<'a>(&self, library: &'a AssetLibrary) -> Option<&'a CaptureAsset> {
        library.asset_by_id(&self.id).filter(|asset| {
            asset.kind == CaptureKind::Image
                && asset.trashed_at.is_none()
                && asset.ocr_revision == self.revision
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FileVersion {
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    unix_identity: (u64, u64, i64, i64),
}

impl FileVersion {
    fn from_metadata(metadata: &Metadata) -> Option<Self> {
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            len: metadata.len(),
            modified: metadata.modified().ok()?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            unix_identity: (metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec()),
        })
    }

    fn at(path: &Path) -> Option<Self> {
        Self::from_metadata(&fs::symlink_metadata(path).ok()?)
    }
}

#[derive(Clone)]
pub(crate) struct SavedOcrSource {
    pub(crate) version: OcrImageVersion,
    path: PathBuf,
    file_version: FileVersion,
}

impl SavedOcrSource {
    pub(crate) fn read(
        version: OcrImageVersion,
        path: PathBuf,
    ) -> Result<(Self, Vec<u8>, u32, u32), String> {
        let png = read_saved_ocr_png(&path)?;
        Ok((
            Self { version, path, file_version: png.file_version },
            png.bytes,
            png.width,
            png.height,
        ))
    }

    pub(crate) fn matches(&self, library: &AssetLibrary, asset: &CaptureAsset) -> bool {
        let path = library.asset_url(asset);
        path == self.path && FileVersion::at(&path).as_ref() == Some(&self.file_version)
    }
}

pub(crate) struct SavedOcrPng {
    pub(crate) bytes: Vec<u8>,
    width: u32,
    height: u32,
    file_version: FileVersion,
}

pub(crate) fn read_saved_ocr_png(path: &Path) -> Result<SavedOcrPng, String> {
    let unreadable = || "Can't read this file.".to_string();
    let file_version = FileVersion::at(path).ok_or_else(unreadable)?;
    let size_error = || "The OCR image exceeds the size limit.".to_string();
    if file_version.len > MAX_PREPARED_PNG_BYTES as u64 {
        return Err(size_error());
    }
    let file = File::open(path).map_err(|_| unreadable())?;
    if file.metadata().ok().and_then(|metadata| FileVersion::from_metadata(&metadata)).as_ref()
        != Some(&file_version)
    {
        return Err(SOURCE_CHANGED.into());
    }
    let mut bytes = Vec::with_capacity(file_version.len as usize);
    file.take(MAX_PREPARED_PNG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    if FileVersion::at(path).as_ref() != Some(&file_version) {
        return Err(SOURCE_CHANGED.into());
    }
    if bytes.len() > MAX_PREPARED_PNG_BYTES {
        return Err(size_error());
    }
    // Bound the decoder before using either the bundled or native engines.
    let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes))
        .map_err(|_| unreadable())?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 64_000_000 {
        return Err(size_error());
    }
    Ok(SavedOcrPng { bytes, width, height, file_version })
}
