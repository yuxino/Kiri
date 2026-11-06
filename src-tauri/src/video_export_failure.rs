//! Path-free export failures for IPC and persistent diagnostics.
//! Preserve typed causes until this boundary; never log arbitrary native messages.
use anyhow::Error;

#[cfg(windows)]
#[derive(Debug, thiserror::Error)]
#[error("Windows native transcode failed with reason {0}")]
pub struct WindowsTranscodeFailure(pub i32);

#[derive(Clone, Copy, Debug)]
pub enum ExportStage {
    Request,
    Source,
    Snapshot,
    Render,
    Save,
    Worker,
}

impl ExportStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Source => "source",
            Self::Snapshot => "snapshot",
            Self::Render => "render",
            Self::Save => "save",
            Self::Worker => "worker",
        }
    }
}

fn code(error: &Error) -> String {
    for cause in error.chain() {
        if let Some(error) = cause.downcast_ref::<std::io::Error>() {
            let kind = match error.kind() {
                std::io::ErrorKind::NotFound => "not_found",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                std::io::ErrorKind::AlreadyExists => "already_exists",
                std::io::ErrorKind::InvalidData => "invalid_data",
                std::io::ErrorKind::InvalidInput => "invalid_input",
                std::io::ErrorKind::WriteZero => "write_zero",
                std::io::ErrorKind::UnexpectedEof => "unexpected_eof",
                std::io::ErrorKind::StorageFull => "storage_full",
                std::io::ErrorKind::ReadOnlyFilesystem => "read_only_filesystem",
                std::io::ErrorKind::TimedOut => "timed_out",
                std::io::ErrorKind::Interrupted => "interrupted",
                std::io::ErrorKind::OutOfMemory => "out_of_memory",
                std::io::ErrorKind::Unsupported => "unsupported",
                _ => "other",
            };
            return format!("io_{kind}");
        }
        #[cfg(windows)]
        if let Some(error) = cause.downcast_ref::<windows::core::Error>() {
            return format!("hresult_{:08X}", error.code().0 as u32);
        }
        #[cfg(windows)]
        if let Some(error) = cause.downcast_ref::<WindowsTranscodeFailure>() {
            return format!("transcode_{:08X}", error.0 as u32);
        }
    }
    "unknown".to_owned()
}

pub fn report(stage: ExportStage, error: Error) -> String {
    let code = code(&error);
    log::warn!("[video-export] failed stage={} code={code}", stage.as_str());
    format!("VIDEO_EXPORT_FAILED:{}:{code}", stage.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_io_cause_survives_without_exposing_paths_or_context() {
        let error = Error::new(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "private-user/video-name.mp4",
        ))
        .context("native message containing private media metadata")
        .context("could not render composition");
        assert_eq!(report(ExportStage::Render, error),
            "VIDEO_EXPORT_FAILED:render:io_permission_denied");
    }

    #[test]
    fn arbitrary_native_text_is_never_returned() {
        for stage in [ExportStage::Request, ExportStage::Source, ExportStage::Snapshot,
            ExportStage::Render, ExportStage::Save, ExportStage::Worker] {
            let result = report(stage, anyhow::anyhow!("private-name\nsecret source path"));
            assert_eq!(result, format!("VIDEO_EXPORT_FAILED:{}:unknown", stage.as_str()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn nested_hresult_keeps_numeric_code_without_native_message() {
        let error = windows::core::Error::new(
            windows::core::HRESULT(0x80070020_u32 as i32), "private file path");
        assert_eq!(report(ExportStage::Render, Error::new(error).context("native reader")),
            "VIDEO_EXPORT_FAILED:render:hresult_80070020");
    }

    #[cfg(windows)]
    #[test]
    fn native_failure_reason_keeps_numeric_code() {
        assert_eq!(report(ExportStage::Render,
            Error::new(WindowsTranscodeFailure(2)).context("native render failed")),
            "VIDEO_EXPORT_FAILED:render:transcode_00000002");
    }
}
