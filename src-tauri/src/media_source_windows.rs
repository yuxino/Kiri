//! Open local media as files, never through Media Foundation's URL resolver.

use anyhow::{Context, Result};
use std::path::Path;
use windows::{core::HSTRING, Win32::Media::MediaFoundation::*};

/// The caller owns COM and Media Foundation initialization. Keeping the file
/// namespace intact supports canonical `\\?\` paths, Unicode and long names.
pub(crate) fn open_reader(path: &Path, attributes: Option<&IMFAttributes>) -> Result<IMFSourceReader> {
    let file = unsafe {
        MFCreateFile(
            MF_ACCESSMODE_READ,
            MF_OPENMODE_FAIL_IF_NOT_EXIST,
            MF_FILEFLAGS_NONE,
            &HSTRING::from(path.as_os_str()),
        )
    }
    .with_context(|| format!("could not open local video {}", path.display()))?;
    unsafe { MFCreateSourceReaderFromByteStream(&file, attributes) }
        .with_context(|| format!("could not decode local video {}", path.display()))
}
