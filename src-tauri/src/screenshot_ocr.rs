//! Optional local OCR of newly saved screenshots for capture search.

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};

use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::mpsc;

use crate::ocr_source::{OcrImageVersion, SavedOcrSource};
use crate::state::{emit_library_changed, save_preference_at, AppState};

const QUEUED_SCREENSHOTS: usize = 8;

pub(crate) struct ScreenshotOcrIndex {
    preference_path: PathBuf,
    // Odd epochs are enabled. Changing the setting invalidates earlier jobs,
    // even when the user re-enables indexing before their OCR finishes.
    epoch: AtomicU64,
    change: Mutex<()>,
    jobs: OnceLock<mpsc::Sender<IndexJob>>,
}

#[derive(Clone, Copy)]
struct IndexJob {
    image: OcrImageVersion,
    epoch: u64,
}

impl ScreenshotOcrIndex {
    pub(crate) fn open(config_dir: &Path) -> Self {
        let preference_path = config_dir.join("screenshot-ocr.json");
        let enabled = std::fs::read(&preference_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<bool>(&data).ok())
            .unwrap_or(false);
        Self {
            preference_path,
            epoch: AtomicU64::new(u64::from(enabled)),
            change: Mutex::new(()),
            jobs: OnceLock::new(),
        }
    }

    fn enabled(&self) -> bool {
        self.epoch.load(Ordering::Acquire) % 2 == 1
    }

    fn set_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let _guard = self.change.lock().unwrap();
        if self.enabled() != enabled {
            save_preference_at(&self.preference_path, &enabled)?;
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        Ok(())
    }

    pub(crate) fn enqueue(&self, app: &AppHandle, image: OcrImageVersion) {
        let epoch = self.epoch.load(Ordering::Acquire);
        if epoch % 2 == 0 {
            return;
        }
        let sender = self.jobs.get_or_init(|| {
            let (sender, receiver) = mpsc::channel(QUEUED_SCREENSHOTS);
            tauri::async_runtime::spawn(index_queue(app.clone(), receiver));
            sender
        });
        // Capture never waits for a worker or queues image bytes.
        if sender.try_send(IndexJob { image, epoch }).is_err() {
            log::debug!("Screenshot OCR queue unavailable; skipping this capture");
        }
    }
}

async fn index_queue(app: AppHandle, mut receiver: mpsc::Receiver<IndexJob>) {
    while let Some(job) = receiver.recv().await {
        let app = app.clone();
        if tauri::async_runtime::spawn_blocking(move || index_screenshot(&app, job))
            .await
            .is_err()
        {
            log::warn!("Screenshot OCR worker failed");
        }
    }
}

fn index_screenshot(app: &AppHandle, job: IndexJob) {
    let state = app.state::<AppState>();
    let index = &state.screenshot_ocr;
    let is_current = || index.epoch.load(Ordering::Acquire) == job.epoch;
    if !is_current() {
        return;
    }
    let path = {
        let mut context = state.library.lock().unwrap();
        if !job.image.matches_library(&context) {
            return;
        }
        let Ok(library) = context.library() else { return };
        let Some(asset) = job.image.active_image(library) else { return };
        library.asset_url(asset)
    };
    let Ok((source, png, _, _)) = SavedOcrSource::read(job.image, path) else {
        return;
    };
    if !is_current() {
        return;
    }
    let resources = app.path().resource_dir().ok();
    let Ok(text) = crate::ocr::recognize_bundled_text(&png, resources.as_deref()) else {
        log::debug!("Bundled OCR could not index a screenshot");
        return;
    };
    if text.trim().is_empty() {
        return;
    }
    let saved = {
        let _preference = index.change.lock().unwrap();
        if !is_current() {
            return;
        }
        let mut context = state.library.lock().unwrap();
        if !job.image.matches_library(&context) {
            return;
        }
        let Ok(library) = context.library_mut() else { return };
        let Some(asset) = job.image.active_image(library) else { return };
        if !source.matches(library, asset) {
            return;
        }
        library.index_screenshot_text(&job.image.id, job.image.revision, text)
    };
    match saved {
        Ok(true) => emit_library_changed(app),
        Ok(false) => {}
        Err(error) => log::warn!("Screenshot text could not be indexed: {error}"),
    }
}

#[tauri::command]
pub fn get_screenshot_ocr_enabled(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<bool, String> {
    crate::ocr_commands::require_library_window(&window)?;
    Ok(app.state::<AppState>().screenshot_ocr.enabled())
}

#[tauri::command]
pub async fn set_screenshot_ocr_enabled(
    window: WebviewWindow,
    app: AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    crate::ocr_commands::require_library_window(&window)?;
    const ERROR: &str = "Couldn't change screenshot text indexing.";
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .screenshot_ocr
            .set_enabled(enabled)
            .map_err(|_| ERROR.to_string())?;
        Ok(enabled)
    })
    .await
    .map_err(|_| ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_index_is_opt_in_and_toggles_invalidate_pending_work() {
        let dir = tempfile::tempdir().unwrap();
        let index = ScreenshotOcrIndex::open(dir.path());
        assert!(!index.enabled());
        index.set_enabled(true).unwrap();
        let earlier = index.epoch.load(Ordering::Acquire);
        assert!(ScreenshotOcrIndex::open(dir.path()).enabled());

        index.set_enabled(false).unwrap();
        index.set_enabled(true).unwrap();
        assert!(index.enabled());
        assert_ne!(index.epoch.load(Ordering::Acquire), earlier);
        index.set_enabled(false).unwrap();
        assert!(!ScreenshotOcrIndex::open(dir.path()).enabled());
    }

    #[test]
    fn a_failed_preference_write_does_not_enable_screenshot_ocr() {
        let dir = tempfile::tempdir().unwrap();
        let index = ScreenshotOcrIndex::open(dir.path());
        std::fs::create_dir(&index.preference_path).unwrap();
        assert!(index.set_enabled(true).is_err());
        assert!(!index.enabled());
    }
}
