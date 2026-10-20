//! macOS capture backend — ScreenCaptureKit via objc2, mirroring
//! CaptureCoordinator.swift / RegionRecorder.swift (legacy backend).

use std::sync::mpsc;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageRep, NSEvent, NSScreen};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDirectDisplayID, CGDisplayBounds, CGImage, CGMainDisplayID};
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMFormatDescription,
    CMSampleBuffer, CMTime,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSObject, NSString};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCScreenshotManager, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};

use crate::core::geometry::Rect;
use crate::core::policy::RecordingOptions;
use crate::record::{AudioChunkSender, AudioQueueSendError, AudioSampleFormat, AudioSpec};

use super::{CaptureHealth, CapturedDisplay};

mod window_selection;
mod audio;
mod scroll_window;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionState {
    Authorized,
    RestartRequired,
    SettingsRequired,
}

/// Process-scoped permission gate. The closures keep the state machine
/// independently testable without invoking macOS privacy APIs from tests.
struct ScreenCapturePermissionGate {
    cached: std::sync::Mutex<Option<PermissionState>>,
}

impl ScreenCapturePermissionGate {
    const fn new() -> Self {
        Self {
            cached: std::sync::Mutex::new(None),
        }
    }

    fn check(
        &self,
        preflight: impl FnOnce() -> bool,
        request: impl FnOnce() -> bool,
    ) -> PermissionState {
        // Hold the gate while checking and requesting so concurrent capture
        // triggers cannot both reach the system request API.
        let mut cached = self.cached.lock().unwrap();
        // Authorized wins unconditionally: if the user grants access in
        // System Settings, preflight overrides any stale denial cache.
        if preflight() {
            *cached = None;
            return PermissionState::Authorized;
        }
        if let Some(state) = *cached {
            return state;
        }
        let state = if request() {
            PermissionState::RestartRequired
        } else {
            PermissionState::SettingsRequired
        };
        *cached = Some(state);
        state
    }
}

// Caches the `CGRequestScreenCaptureAccess` outcome so the system prompt is
// shown at most once per launch (mirrors `ScreenCapturePermissionGate`:
// "已有缓存 → 直接返回缓存值,避免重复弹权限框"). Without this, every
// `start_capture` re-invoked the request API and macOS re-prompts even
// though the user already granted (or already declined) access.
static PERMISSION_GATE: ScreenCapturePermissionGate = ScreenCapturePermissionGate::new();

/// Mirrors `ScreenCapturePermissionGate` (preflight → request, cached).
pub fn check_capture_permission() -> PermissionState {
    PERMISSION_GATE.check(
        || unsafe { CGPreflightScreenCaptureAccess() },
        || unsafe { CGRequestScreenCaptureAccess() },
    )
}

#[cfg(test)]
mod permission_tests {
    use std::cell::Cell;

    use super::{PermissionState, ScreenCapturePermissionGate};

    #[test]
    fn authorized_preflight_never_requests_access() {
        let gate = ScreenCapturePermissionGate::new();
        let request_count = Cell::new(0);

        let state = gate.check(
            || true,
            || {
                request_count.set(request_count.get() + 1);
                false
            },
        );

        assert_eq!(state, PermissionState::Authorized);
        assert_eq!(request_count.get(), 0);
    }

    #[test]
    fn denied_request_is_cached_for_the_process() {
        let gate = ScreenCapturePermissionGate::new();
        let request_count = Cell::new(0);

        for _ in 0..2 {
            let state = gate.check(
                || false,
                || {
                    request_count.set(request_count.get() + 1);
                    false
                },
            );
            assert_eq!(state, PermissionState::SettingsRequired);
        }

        assert_eq!(request_count.get(), 1);
    }

    #[test]
    fn granted_request_is_cached_until_preflight_authorizes() {
        let gate = ScreenCapturePermissionGate::new();
        let request_count = Cell::new(0);

        let first = gate.check(
            || false,
            || {
                request_count.set(request_count.get() + 1);
                true
            },
        );
        let cached = gate.check(
            || false,
            || {
                request_count.set(request_count.get() + 1);
                false
            },
        );
        let authorized = gate.check(|| true, || false);

        assert_eq!(first, PermissionState::RestartRequired);
        assert_eq!(cached, PermissionState::RestartRequired);
        assert_eq!(authorized, PermissionState::Authorized);
        assert_eq!(request_count.get(), 1);
    }
}

// ---------------------------------------------------------------------------
// Frozen display capture (CaptureCoordinator equivalent)
// ---------------------------------------------------------------------------

struct ActiveScreen {
    frame: Rect,
    display_id: CGDirectDisplayID,
    backing_scale: f64,
}

fn appkit_frame_to_tauri(frame: CGRect, main_display_height: f64) -> Rect {
    Rect::new(
        frame.origin.x,
        main_display_height - (frame.origin.y + frame.size.height),
        frame.size.width,
        frame.size.height,
    )
}

fn active_screen() -> Result<ActiveScreen> {
    let mtm = objc2::MainThreadMarker::new().unwrap();
    let mouse = NSEvent::mouseLocation();
    let point = CGPoint {
        x: mouse.x,
        y: mouse.y,
    };
    let screens = NSScreen::screens(mtm);
    let screen = screens
        .iter()
        .find(|screen| {
            let frame = screen.frame();
            point.x >= frame.origin.x
                && point.x <= frame.origin.x + frame.size.width
                && point.y >= frame.origin.y
                && point.y <= frame.origin.y + frame.size.height
        })
        .or_else(|| screens.firstObject())
        .ok_or_else(|| anyhow!("display unavailable"))?;

    screen_geometry(&screen)
}

fn screen_geometry(screen: &NSScreen) -> Result<ActiveScreen> {
    let frame = screen.frame();
    let display_id = screen
        .deviceDescription()
        .objectForKey(&NSString::from_str("NSScreenNumber"))
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .map(|number| number.unsignedIntValue() as CGDirectDisplayID)
        .ok_or_else(|| anyhow!("display unavailable"))?;
    let backing_scale = screen.backingScaleFactor().max(1.0);

    // `NSScreen.mainScreen` follows the key window and can therefore switch
    // to a fullscreen app's secondary display. Tauri/tao uses the fixed Core
    // Graphics main display as its top-left coordinate baseline, so mirror
    // that stable basis here to keep overlays on vertically arranged screens.
    let main_bounds = CGDisplayBounds(CGMainDisplayID());
    let main_height = main_bounds.origin.y + main_bounds.size.height;
    let top_left = appkit_frame_to_tauri(frame, main_height);
    Ok(ActiveScreen {
        frame: top_left,
        display_id,
        backing_scale,
    })
}

#[cfg(test)]
mod active_screen_tests {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    use super::{appkit_frame_to_tauri, validate_recording_geometry};

    fn frame(x: f64, y: f64, width: f64, height: f64) -> CGRect {
        CGRect {
            origin: CGPoint { x, y },
            size: CGSize { width, height },
        }
    }

    #[test]
    fn recording_accepts_unchanged_negative_origin_retina_display() {
        let frame = crate::core::geometry::Rect::new(-1512.0, -982.0, 1512.0, 982.0);
        assert!(validate_recording_geometry(frame, 2.0, frame, 2.0).is_ok());
    }

    #[test]
    fn recording_rejects_same_display_id_with_changed_layout_resolution_or_scale() {
        let frozen = crate::core::geometry::Rect::new(-1512.0, -982.0, 1512.0, 982.0);
        for (current, scale) in [
            (crate::core::geometry::Rect::new(0.0, 0.0, 1512.0, 982.0), 2.0),
            (crate::core::geometry::Rect::new(-1512.0, 0.0, 1512.0, 982.0), 2.0),
            (crate::core::geometry::Rect::new(-1512.0, -982.0, 1920.0, 1080.0), 2.0),
            (frozen, 1.0),
        ] {
            let error = validate_recording_geometry(frozen, 2.0, current, scale).unwrap_err();
            assert!(error.to_string().contains("Start a new capture"));
        }
    }

    #[test]
    fn recording_rejects_invalid_backing_scale() {
        let frame = crate::core::geometry::Rect::new(0.0, 0.0, 1512.0, 982.0);
        for scale in [0.0, f64::NAN, f64::INFINITY] {
            assert!(validate_recording_geometry(frame, scale, frame, scale).is_err());
        }
    }

    #[test]
    fn converts_primary_appkit_frame_to_tauri_top_left_coordinates() {
        assert_eq!(
            appkit_frame_to_tauri(frame(0.0, 0.0, 1440.0, 900.0), 900.0),
            crate::core::geometry::Rect::new(0.0, 0.0, 1440.0, 900.0)
        );
    }

    #[test]
    fn converts_displays_above_and_below_the_primary() {
        assert_eq!(
            appkit_frame_to_tauri(frame(120.0, 900.0, 1920.0, 1080.0), 900.0),
            crate::core::geometry::Rect::new(120.0, -1080.0, 1920.0, 1080.0)
        );
        assert_eq!(
            appkit_frame_to_tauri(frame(-1920.0, -1080.0, 1920.0, 1080.0), 900.0),
            crate::core::geometry::Rect::new(-1920.0, 900.0, 1920.0, 1080.0)
        );
    }
}

/// Compare in the same global logical coordinate space as the frozen overlay.
/// This runs on main immediately before constructing the recording filter.
fn validate_recording_geometry(
    expected_frame: Rect,
    expected_scale: f64,
    current_frame: Rect,
    current_scale: f64,
) -> Result<()> {
    if expected_frame != current_frame
        || !expected_scale.is_finite()
        || expected_scale < 1.0
        || expected_scale != current_scale
    {
        bail!("The selected display geometry changed. Start a new capture before recording.");
    }
    Ok(())
}

fn shareable_content(_main_thread: MainThreadMarker) -> Result<Retained<SCShareableContent>> {
    // The marker makes it impossible for call sites to initiate this
    // MainThreadOnly request from a Tokio worker.
    let (tx, rx) = mpsc::channel::<std::result::Result<Retained<SCShareableContent>, String>>();
    let block = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = if error.is_null() && !content.is_null() {
                // Completion handlers deliver autoreleased (+0) objects; retain.
                Ok(unsafe { Retained::retain(content).unwrap() })
            } else if !error.is_null() {
                let error = unsafe { Retained::retain(error).unwrap() };
                Err(error.localizedDescription().to_string())
            } else {
                Err("shareable content failed".to_string())
            };
            let _ = tx.send(result);
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            false,
            true,
            &block,
        );
    }
    log::info!("shareable_content: waiting for SCK callback…");
    let result = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| anyhow!("shareable content timed out after 8s"))?;
    log::info!("shareable_content: got SCK callback");
    result.map_err(|message| anyhow!(message))
}

fn make_filter(
    content: &SCShareableContent,
    display: &SCDisplay,
    own_process_id: i32,
    excepted_window_ids: &[u32],
) -> Retained<SCContentFilter> {
    let applications = unsafe { content.applications() };
    let kiri_application = applications
        .iter()
        .find(|app| unsafe { app.processID() } == own_process_id);
    match kiri_application {
        Some(application) => {
            let windows = unsafe { content.windows() };
            let excepted: Vec<Retained<SCWindow>> = windows
                .iter()
                .filter(|window| {
                    unsafe { window.owningApplication() }.map(|app| unsafe { app.processID() })
                        == Some(own_process_id)
                        && excepted_window_ids.contains(&unsafe { window.windowID() })
                })
                .collect();
            unsafe {
                let applications = NSArray::from_slice(&[&*application]);
                let excepted_refs: Vec<&SCWindow> = excepted.iter().map(|w| &**w).collect();
                SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    display,
                    &applications,
                    &NSArray::from_slice(&excepted_refs),
                )
            }
        }
        None => {
            let windows = unsafe { content.windows() };
            let excluded: Vec<Retained<SCWindow>> = windows
                .iter()
                .filter(|window| {
                    unsafe { window.owningApplication() }.map(|app| unsafe { app.processID() })
                        == Some(own_process_id)
                        && !excepted_window_ids.contains(&unsafe { window.windowID() })
                })
                .collect();
            unsafe {
                let excluded_refs: Vec<&SCWindow> = excluded.iter().map(|w| &**w).collect();
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    display,
                    &NSArray::from_slice(&excluded_refs),
                )
            }
        }
    }
}

/// Sendable ownership wrapper for a retained SCContentFilter pointer. If a
/// timed-out receiver drops a queued completion, Drop still balances the
/// native retain instead of leaking it at the timeout boundary.
struct RecordingFilterPointer(Option<usize>);

impl RecordingFilterPointer {
    fn into_raw(mut self) -> usize {
        self.0
            .take()
            .expect("recording filter pointer consumed once")
    }
}

impl Drop for RecordingFilterPointer {
    fn drop(&mut self) {
        if let Some(pointer) = self.0.take() {
            unsafe {
                drop(Retained::from_raw(pointer as *mut SCContentFilter));
            }
        }
    }
}

fn recording_filter_pointer(
    display_id: u32,
    expected_frame: Rect,
    expected_scale: f64,
    own_process_id: i32,
    excepted_window_ids: Vec<u32>,
) -> Result<usize> {
    if MainThreadMarker::new().is_some() {
        bail!("recording filter preparation must not block the main thread");
    }

    let (tx, rx) = mpsc::channel::<std::result::Result<RecordingFilterPointer, String>>();
    // Only registration happens synchronously on main. Waiting for SCK stays
    // on the async command's worker thread below.
    dispatch2::run_on_main(move |_main_thread| {
        let block = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                if !error.is_null() {
                    let error = unsafe { Retained::retain(error).unwrap() };
                    let _ = tx.send(Err(error.localizedDescription().to_string()));
                    return;
                }
                if content.is_null() {
                    let _ = tx.send(Err("shareable content failed".to_string()));
                    return;
                }

                // Retain on the callback queue, then consume and inspect the
                // MainThreadOnly object inside a main-thread closure.
                let content = unsafe { Retained::retain(content).unwrap() };
                let content_pointer = Retained::into_raw(content) as usize;
                let completion_tx = tx.clone();
                let excepted_window_ids = excepted_window_ids.clone();
                dispatch2::run_on_main(move |_main_thread| {
                    let result = (|| -> std::result::Result<RecordingFilterPointer, String> {
                        let content = unsafe {
                            Retained::from_raw(content_pointer as *mut SCShareableContent)
                        }
                        .ok_or_else(|| {
                            "shareable content callback returned an invalid object".to_string()
                        })?;
                        let displays = unsafe { content.displays() };
                        let display = displays
                            .iter()
                            .find(|display| unsafe { display.displayID() } == display_id)
                            .ok_or_else(|| {
                                "The selected display is no longer available. Start a new capture.".to_string()
                            })?;
                        // A display ID survives resolution, scale and layout changes.
                        // The frozen selection and control windows still use the old
                        // geometry, so refuse to start against a different layout.
                        let screens = NSScreen::screens(_main_thread);
                        let current = screens
                            .iter()
                            .filter_map(|screen| screen_geometry(&screen).ok())
                            .find(|screen| screen.display_id == display_id)
                            .ok_or_else(|| {
                                "The selected display is no longer available. Start a new capture."
                                    .to_string()
                            })?;
                        validate_recording_geometry(
                            expected_frame,
                            expected_scale,
                            current.frame,
                            current.backing_scale,
                        )
                        .map_err(|error| error.to_string())?;
                        let filter =
                            make_filter(&content, &display, own_process_id, &excepted_window_ids);
                        Ok(RecordingFilterPointer(Some(
                            Retained::into_raw(filter) as usize
                        )))
                    })();
                    // SendError owns and drops a successful pointer guard, so
                    // a completion racing a timeout cannot leak the filter.
                    let _ = completion_tx.send(result);
                });
            },
        );
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false,
                true,
                &block,
            );
        }
    });

    let pointer = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| anyhow!("shareable content timed out after 8s"))?
        .map_err(|message| anyhow!(message))?;
    Ok(pointer.into_raw())
}

fn collect_window_rects(content: &SCShareableContent, display_id: CGDirectDisplayID) -> Vec<Rect> {
    let display_bounds = CGDisplayBounds(display_id);
    let windows = unsafe { content.windows() };
    let candidates = windows.iter().map(|window| {
        let frame = unsafe { window.frame() };
        let owner = unsafe { window.owningApplication() };
        window_selection::Candidate {
            id: unsafe { window.windowID() },
            layer: unsafe { window.windowLayer() },
            on_screen: unsafe { window.isOnScreen() },
            owner_pid: owner.as_ref().map(|app| unsafe { app.processID() }).unwrap_or(0),
            owner_bundle_id: owner.as_ref()
                .map(|app| unsafe { app.bundleIdentifier() }.to_string()).unwrap_or_default(),
            frame: Rect::new(frame.origin.x, frame.origin.y, frame.size.width, frame.size.height),
        }
    }).collect();
    window_selection::candidate_rects(candidates,
        Rect::new(display_bounds.origin.x, display_bounds.origin.y,
            display_bounds.size.width, display_bounds.size.height),
        std::process::id() as i32, &window_selection::visible_window_order())
}

fn cgimage_to_png(image: &CFRetained<CGImage>) -> Result<(Vec<u8>, i64, i64)> {
    let image_ref: &CGImage = image;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image_ref);
    let width = rep.pixelsWide() as i64;
    let height = rep.pixelsHigh() as i64;
    let data = unsafe {
        rep.representationUsingType_properties(
            objc2_app_kit::NSBitmapImageFileType::PNG,
            &NSDictionary::new(),
        )
    }
    .ok_or_else(|| anyhow!("could not encode capture as PNG"))?;
    let mut bytes = vec![0u8; data.len()];
    unsafe {
        data.getBytes_length(
            std::ptr::NonNull::new_unchecked(bytes.as_mut_ptr() as *mut std::ffi::c_void),
            data.len(),
        );
    }
    Ok((bytes, width, height))
}

const SCREENSHOT_CALLBACK_TIMEOUT: Duration = Duration::from_secs(8);

fn receive_screenshot_callback<T>(
    receiver: &mpsc::Receiver<std::result::Result<T, String>>,
    timeout: Duration,
) -> Result<T> {
    match receiver.recv_timeout(timeout) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(anyhow!(message)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(anyhow!("screenshot capture timed out after 8s"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(anyhow!("screenshot callback disconnected"))
        }
    }
}

#[cfg(test)]
mod screenshot_callback_tests {
    use super::*;

    #[test]
    fn timeout_and_disconnection_have_distinct_errors() {
        let (_sender, receiver) = mpsc::channel::<std::result::Result<(), String>>();
        let timeout = receive_screenshot_callback(&receiver, Duration::ZERO).unwrap_err();
        assert_eq!(timeout.to_string(), "screenshot capture timed out after 8s");

        let (sender, receiver) = mpsc::channel::<std::result::Result<(), String>>();
        drop(sender);
        let disconnected = receive_screenshot_callback(&receiver, Duration::ZERO).unwrap_err();
        assert_eq!(disconnected.to_string(), "screenshot callback disconnected");
    }
}

pub fn capture_active_display() -> Result<CapturedDisplay> {
    match check_capture_permission() {
        PermissionState::Authorized => {}
        PermissionState::RestartRequired => {
            bail!("Screen Recording access was granted. Quit and reopen Kiri once to finish enabling capture.")
        }
        PermissionState::SettingsRequired => {
            bail!("Screen Recording is off. Enable Kiri in System Settings, then quit and reopen it once.")
        }
    }

    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| anyhow!("display capture must start on the main thread"))?;
    let screen = active_screen()?;
    let content = shareable_content(main_thread)?;
    let displays = unsafe { content.displays() };
    let display = displays
        .iter()
        .find(|display| unsafe { display.displayID() } == screen.display_id)
        .ok_or_else(|| anyhow!("the active display could not be captured"))?;

    let window_rects = collect_window_rects(&content, screen.display_id);
    let own_process_id = std::process::id() as i32;
    let filter = make_filter(&content, &display, own_process_id, &[]);

    let configuration = unsafe {
        let configuration = SCStreamConfiguration::new();
        let width = ((display.width() as f64) * screen.backing_scale)
            .round()
            .max(1.0) as i64;
        let height = ((display.height() as f64) * screen.backing_scale)
            .round()
            .max(1.0) as i64;
        configuration.setWidth(width as usize);
        configuration.setHeight(height as usize);
        configuration.setShowsCursor(false);
        configuration
    };

    // CGImage is a CoreFoundation object: retain with CF semantics (the
    // handler delivers a borrowed reference).
    let (tx, rx) = mpsc::channel::<std::result::Result<CFRetained<CGImage>, String>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let result = if error.is_null() && !image.is_null() {
            Ok(unsafe { CFRetained::retain(std::ptr::NonNull::new_unchecked(image)) })
        } else if !error.is_null() {
            let error = unsafe { Retained::retain(error).unwrap() };
            Err(error.localizedDescription().to_string())
        } else {
            Err("screenshot failed".to_string())
        };
        let _ = tx.send(result);
    });
    let block_ref: &block2::Block<dyn Fn(*mut CGImage, *mut NSError)> = &block;
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &configuration,
            Some(block_ref),
        );
    }
    let image = receive_screenshot_callback(&rx, SCREENSHOT_CALLBACK_TIMEOUT)?;

    let (png_data, pixel_width, pixel_height) = cgimage_to_png(&image)?;
    Ok(CapturedDisplay {
        png_data: png_data.into(),
        pixel_width,
        pixel_height,
        screen_frame: screen.frame,
        window_rects,
        display_id: screen.display_id,
        display_identity: None,
        backing_scale: screen.backing_scale,
    })
}

// ---------------------------------------------------------------------------
// Recording (RegionRecorder legacy-backend equivalent)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct AudioFormat {
    pub channels: u32,
    pub is_float: bool,
    pub is_non_interleaved: bool,
}

struct DelegateSenders {
    video_tx: super::VideoFrameSender,
    audio_tx: Option<AudioChunkSender>,
    mic_tx: Option<AudioChunkSender>,
}

struct DelegateState {
    senders: Weak<DelegateSenders>,
    capture_health: Arc<CaptureHealth>,
    audio_format: OnceLock<AudioFormat>,
    mic_normalizer: std::sync::Mutex<audio::MicrophoneNormalizer>,
    /// Set before the stream stops so late frame callbacks (already queued
    /// on the SCK queue) become no-ops instead of sending into a channel
    /// whose receiver is gone.
    stopped: std::sync::atomic::AtomicBool,
    /// Total frames forwarded to the encoder (debug counter).
    frames: std::sync::atomic::AtomicU64,
    /// Frames discarded because the bounded encoder queue was full.
    dropped_frames: std::sync::atomic::AtomicU64,
    dropped_audio_chunks: std::sync::atomic::AtomicU64,
    dropped_mic_chunks: std::sync::atomic::AtomicU64,
}

/// A recording session running the SCK stream on a dedicated thread.
/// SCStream is `AnyThread` in objc2 (not Send/Sync), so the stream never
/// leaves the thread that created it; control flows through channels.
pub struct MacRecordingSession {
    stop_tx: mpsc::Sender<()>,
    /// Receives the stream-thread's completion notification after a stop.
    stop_done_rx: mpsc::Receiver<std::result::Result<(), String>>,
    thread: Option<std::thread::JoinHandle<()>>,
    capture_health: Arc<CaptureHealth>,
}

impl MacRecordingSession {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        display_id: u32,
        screen_frame: Rect,
        region: Rect,
        backing_scale: f64,
        options: RecordingOptions,
        excepted_window_ids: &[u32],
        video_tx: super::VideoFrameSender,
        audio_tx: Option<AudioChunkSender>,
        mic_tx: Option<AudioChunkSender>,
    ) -> Result<MacRecordingSession> {
        if region.width < 2.0 || region.height < 2.0 {
            bail!("The recording region is too small.");
        }
        if options.captures_microphone && !crate::platform::mic_supported() {
            bail!("Microphone recording requires macOS 15 or later.");
        }

        let microphone_device_id = if options.captures_microphone {
            crate::microphone::devices::macos_capture_id(options.microphone_device_id.as_deref())?
        } else { None };

        let audio_spec = AudioSpec {
            sample_rate: 48_000,
            channels: 2,
            format: AudioSampleFormat::F32,
        };
        if let Some(tx) = &audio_tx {
            tx.configure(audio_spec)?;
        }
        if let Some(tx) = &mic_tx {
            tx.configure(audio_spec)?;
        }

        // SCShareableContent and the objects obtained from it are
        // MainThreadOnly. Build the filter on the main thread, then transfer
        // its retained ownership to the dedicated stream thread as a raw
        // pointer. No SCK content object is inspected on the Tokio worker.
        let own_process_id = std::process::id() as i32;
        let filter_ptr = recording_filter_pointer(
            display_id,
            screen_frame,
            backing_scale,
            own_process_id,
            excepted_window_ids.to_vec(),
        )?;
        log::info!("MacRecordingSession: filter created");

        let width =
            crate::core::policy::RecordingPolicy::pixel_dimension(region.width, backing_scale);
        let height =
            crate::core::policy::RecordingPolicy::pixel_dimension(region.height, backing_scale);

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (result_tx, result_rx) = mpsc::channel::<Result<()>>();
        let (stop_done_tx, stop_done_rx) = mpsc::channel::<std::result::Result<(), String>>();
        let capture_health = Arc::new(CaptureHealth::default());
        let stream_capture_health = Arc::clone(&capture_health);
        log::info!("MacRecordingSession: spawning stream thread");
        let thread = std::thread::spawn(move || {
            log::info!("MacRecordingSession: stream thread running");
            let filter = unsafe { Retained::from_raw(filter_ptr as *mut SCContentFilter).unwrap() };
            let configuration = unsafe {
                let configuration = SCStreamConfiguration::new();
                // SCK sourceRect is display-local, top-left origin, in points.
                configuration.setSourceRect(CGRect {
                    origin: CGPoint {
                        x: region.x,
                        y: region.y,
                    },
                    size: CGSize {
                        width: region.width,
                        height: region.height,
                    },
                });
                configuration.setWidth(width as usize);
                configuration.setHeight(height as usize);
                configuration.setMinimumFrameInterval(CMTime {
                    value: 1,
                    timescale: crate::core::policy::RecordingPolicy::FRAMES_PER_SECOND as i32,
                    flags: objc2_core_media::CMTimeFlags(1),
                    epoch: 0,
                });
                // Three IOSurfaces absorb short ScreenCaptureKit scheduling
                // jitter without retaining six full 4K frames. The Rust hand-
                // off is independently bounded to two frames and drops on
                // encoder backpressure, so a deeper native queue only adds
                // memory and latency rather than useful resilience.
                configuration.setQueueDepth(3);
                configuration.setPixelFormat(0x4247_5241); // kCVPixelFormatType_32BGRA
                configuration
                    .setCaptureResolution(objc2_screen_capture_kit::SCCaptureResolutionType::Best);
                configuration.setScalesToFit(false);
                configuration.setShowsCursor(options.shows_cursor);
                // Mouse-click highlighting is off by default. Its setter is
                // macOS 15+, so do not send that selector on supported macOS 14.
                configuration.setCapturesAudio(options.captures_system_audio);
                if options.captures_microphone {
                    // This selector is available on macOS 15+. The backend
                    // rejects microphone capture on older systems before the
                    // stream thread starts, so it is never sent there.
                    configuration.setCaptureMicrophone(true);
                    if let Some(id) = &microphone_device_id {
                        configuration.setMicrophoneCaptureDeviceID(Some(&NSString::from_str(id)));
                    }
                }
                configuration.setExcludesCurrentProcessAudio(true);
                configuration.setSampleRate(48_000);
                configuration.setChannelCount(2);
                configuration
            };

            let senders = Arc::new(DelegateSenders {
                video_tx,
                audio_tx,
                mic_tx,
            });
            let state = Arc::new(DelegateState {
                senders: Arc::downgrade(&senders),
                capture_health: stream_capture_health,
                audio_format: OnceLock::new(),
                mic_normalizer: std::sync::Mutex::new(audio::MicrophoneNormalizer::default()),
                stopped: std::sync::atomic::AtomicBool::new(false),
                frames: std::sync::atomic::AtomicU64::new(0),
                dropped_frames: std::sync::atomic::AtomicU64::new(0),
                dropped_audio_chunks: std::sync::atomic::AtomicU64::new(0),
                dropped_mic_chunks: std::sync::atomic::AtomicU64::new(0),
            });

            let delegate = KiriStreamDelegate::with_state(state);
            let queue = dispatch2::DispatchQueue::new("io.yuxino.kiri.stream", None);

            let delegate_ref: &KiriStreamDelegate = &delegate;
            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &configuration,
                    Some(ProtocolObject::from_ref(delegate_ref)),
                )
            };
            let output: &ProtocolObject<dyn SCStreamOutput> =
                ProtocolObject::from_ref(delegate_ref);
            let mut registered_outputs = Vec::new();
            if let Err(error) = unsafe {
                stream.addStreamOutput_type_sampleHandlerQueue_error(
                    output,
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
            } {
                let _ = remove_stream_outputs(&stream, output, &queue, &registered_outputs);
                let _ = result_tx.send(Err(anyhow!("{error:?}")));
                return;
            }
            registered_outputs.push(SCStreamOutputType::Screen);
            if options.captures_system_audio {
                if let Err(error) = unsafe {
                    stream.addStreamOutput_type_sampleHandlerQueue_error(
                        output,
                        SCStreamOutputType::Audio,
                        Some(&queue),
                    )
                } {
                    let _ = remove_stream_outputs(&stream, output, &queue, &registered_outputs);
                    let _ = result_tx.send(Err(anyhow!("{error:?}")));
                    return;
                }
                registered_outputs.push(SCStreamOutputType::Audio);
            }
            if options.captures_microphone {
                if let Err(error) = unsafe {
                    stream.addStreamOutput_type_sampleHandlerQueue_error(
                        output,
                        SCStreamOutputType::Microphone,
                        Some(&queue),
                    )
                } {
                    let _ = remove_stream_outputs(&stream, output, &queue, &registered_outputs);
                    let _ = result_tx.send(Err(anyhow!("{error:?}")));
                    return;
                }
                registered_outputs.push(SCStreamOutputType::Microphone);
            }

            log::info!("MacRecordingSession: starting capture…");
            if let Err(error) = start_capture_sync(&stream) {
                log::error!("MacRecordingSession: start_capture_sync failed: {error}");
                let _ = remove_stream_outputs(&stream, output, &queue, &registered_outputs);
                let _ = result_tx.send(Err(error));
                return;
            }
            log::info!("MacRecordingSession: capture started");
            let _ = result_tx.send(Ok(()));

            log::info!("MacRecordingSession: stream thread got stop signal");
            let _ = stop_rx.recv();
            let state = &delegate.ivars().state;
            state
                .stopped
                .store(true, std::sync::atomic::Ordering::Release);
            log::info!(
                "MacRecordingSession: stopping after {} frames ({} dropped by backpressure)",
                state.frames.load(std::sync::atomic::Ordering::Relaxed),
                state
                    .dropped_frames
                    .load(std::sync::atomic::Ordering::Relaxed)
            );
            // Removing outputs prevents new sample delivery; the empty
            // synchronous task is then a FIFO drain barrier on the serial
            // sample queue. Do not call stopCaptureWithCompletionHandler
            // here: on affected macOS versions that call can block before a
            // completion is scheduled (the reason Kiri previously removed
            // it in the recording-stop deadlock fix).
            let stop_result = remove_stream_outputs(&stream, output, &queue, &registered_outputs);
            // The delegate intentionally holds only a Weak reference. Queue
            // drain guarantees no callback owns a temporary strong Arc, so
            // this closes every frame channel before stop_done and gives
            // the native encoder deterministic EOF even if SCK retains the delegate.
            drop(senders);
            log::info!("MacRecordingSession: capture stopped; releasing stream…");
            // DelegateState is owned by the Objective-C delegate through an
            // Arc. Any callback already retained by SCK therefore keeps the
            // state alive as a final safety net; the queue drain above is the
            // synchronization that lets normal shutdown release it now.
            drop(stream);
            drop(delegate);
            drop(queue);
            // Notify the stop waiter that the stream thread has finished
            // releasing stream/delegate ownership and all frame senders have
            // closed, so the native encoder has observed EOF.
            let _ = stop_done_tx.send(stop_result.map_err(|error| error.to_string()));
        });

        log::info!("MacRecordingSession: waiting for stream thread result…");
        result_rx
            .recv()
            .map_err(|_| anyhow!("recorder thread exited early"))??;
        log::info!("MacRecordingSession: stream thread ready");
        Ok(MacRecordingSession {
            stop_tx,
            stop_done_rx,
            thread: Some(thread),
            capture_health,
        })
    }

    fn request_stop(&mut self) -> Result<()> {
        if self.thread.is_none() {
            return Ok(());
        }
        log::info!("MacRecordingSession: request_stop sending…");
        // Mark user-initiated shutdown before signaling the stream thread so
        // a synchronous didStopWithError callback cannot race into the
        // unexpected-failure slot during normal teardown.
        self.capture_health.begin_expected_stop();
        let _ = self.stop_tx.send(());
        // The result_rx is a one-shot used at start; the stop completion is
        // delivered on stop_done_rx. Waiting on result_rx here would
        // immediately error ("recorder thread exited early") because its
        // sender was already dropped after the start handshake.
        let stop_result = match self
            .stop_done_rx
            .recv_timeout(std::time::Duration::from_secs(8))
        {
            Ok(result) => result.map_err(|error| anyhow!(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // The thread still owns its stream, delegate, and Arc state.
                // Detach rather than defeating the timeout with an unbounded
                // join; late cleanup remains memory-safe.
                let _ = self.thread.take();
                return Err(anyhow!("recorder stop timed out"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(anyhow!("recorder thread exited during shutdown"))
            }
        };
        let join_result = if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("recorder thread panicked during shutdown"))
        } else {
            Ok(())
        };
        // Always join, even when native stop reported an error. Otherwise
        // Drop would retry a consumed one-shot and detach the cleanup thread.
        join_result?;
        stop_result?;
        if let Some(error) = self.capture_health.unexpected_failure() {
            bail!("Screen capture stopped unexpectedly: {error}");
        }
        log::info!("MacRecordingSession: request_stop done");
        Ok(())
    }
}

impl super::PlatformRecorder for MacRecordingSession {
    fn stop(&mut self) -> Result<()> {
        self.request_stop()
    }
}

impl Drop for MacRecordingSession {
    fn drop(&mut self) {
        let _ = self.request_stop();
    }
}

fn start_capture_sync(stream: &SCStream) -> Result<()> {
    let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
    let block = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            let error = unsafe { Retained::retain(error).unwrap() };
            Err(error.localizedDescription().to_string())
        };
        let _ = tx.send(result);
    });
    let block_ref: &block2::Block<dyn Fn(*mut NSError)> = &block;
    unsafe { stream.startCaptureWithCompletionHandler(Some(block_ref)) };
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| anyhow!("start capture timed out"))?
        .map_err(|message| anyhow!(message))
}

fn remove_stream_outputs(
    stream: &SCStream,
    output: &ProtocolObject<dyn SCStreamOutput>,
    queue: &dispatch2::DispatchQueue,
    registered_outputs: &[SCStreamOutputType],
) -> Result<()> {
    let mut first_error = None;
    for output_type in registered_outputs.iter().rev().copied() {
        if let Err(error) = unsafe { stream.removeStreamOutput_type_error(output, output_type) } {
            first_error.get_or_insert_with(|| anyhow!("{error:?}"));
        }
    }
    // DispatchQueue::new creates a serial queue. A synchronous no-op from the
    // recorder thread waits for every previously submitted callback.
    queue.exec_sync(|| {});
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Stream delegate
// ---------------------------------------------------------------------------

fn audio_format_from(buffer: &CMSampleBuffer) -> Option<AudioFormat> {
    let desc: CFRetained<CMFormatDescription> = unsafe { buffer.format_description() }?;
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&desc) };
    if asbd.is_null() {
        return None;
    }
    let asbd = unsafe { &*asbd };
    const IS_FLOAT: u32 = 1 << 0;
    const IS_NON_INTERLEAVED: u32 = 1 << 5;
    Some(AudioFormat {
        channels: asbd.mChannelsPerFrame,
        is_float: asbd.mFormatFlags & IS_FLOAT != 0,
        is_non_interleaved: asbd.mFormatFlags & IS_NON_INTERLEAVED != 0,
    })
}

fn copy_pixel_buffer(buffer: &CMSampleBuffer) -> Option<Vec<u8>> {
    let pixel_buffer: CFRetained<CVPixelBuffer> = unsafe { buffer.image_buffer() }?;
    let pixel_buffer_ref: &CVPixelBuffer = &pixel_buffer;
    unsafe { CVPixelBufferLockBaseAddress(pixel_buffer_ref, CVPixelBufferLockFlags::ReadOnly) };
    let result = unsafe {
        let base = CVPixelBufferGetBaseAddress(pixel_buffer_ref);
        if base.is_null() {
            CVPixelBufferUnlockBaseAddress(pixel_buffer_ref, CVPixelBufferLockFlags::ReadOnly);
            return None;
        }
        let bytes_per_row = CVPixelBufferGetBytesPerRow(pixel_buffer_ref);
        let height = CVPixelBufferGetHeight(pixel_buffer_ref);
        let row_bytes = CVPixelBufferGetWidth(pixel_buffer_ref) * 4;
        let mut out = Vec::with_capacity(row_bytes * height);
        for row in 0..height {
            let src = base.add(row * bytes_per_row) as *const u8;
            out.extend_from_slice(std::slice::from_raw_parts(src, row_bytes));
        }
        CVPixelBufferUnlockBaseAddress(pixel_buffer_ref, CVPixelBufferLockFlags::ReadOnly);
        out
    };
    Some(result)
}

fn copy_audio_buffer(buffer: &CMSampleBuffer) -> Option<Vec<u8>> {
    let block: CFRetained<CMBlockBuffer> = unsafe { buffer.data_buffer() }?;
    let mut data_ptr: *mut std::ffi::c_char = std::ptr::null_mut();
    let mut length = 0usize;
    let mut total = 0usize;
    let status = unsafe { block.data_pointer(0, &mut length, &mut total, &mut data_ptr) };
    if status != 0 || data_ptr.is_null() || length == 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(data_ptr as *const u8, length) }.to_vec())
}

fn deinterleave_f32(planar: &[u8], channels: u32, _format: AudioFormat) -> Vec<u8> {
    let frames = planar.len() / (4 * channels as usize);
    let mut interleaved = Vec::with_capacity(planar.len());
    for frame in 0..frames {
        for channel in 0..channels as usize {
            let offset = (channel * frames + frame) * 4;
            interleaved.extend_from_slice(&planar[offset..offset + 4]);
        }
    }
    interleaved
}

fn forward_audio_chunk(
    tx: &AudioChunkSender,
    payload: Vec<u8>,
    dropped_chunks: &std::sync::atomic::AtomicU64,
    source: &str,
) {
    match tx.try_send(payload) {
        Ok(()) | Err(AudioQueueSendError::Closed) => {}
        Err(error @ (AudioQueueSendError::Unconfigured | AudioQueueSendError::Overloaded)) => {
            let dropped = dropped_chunks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if dropped == 1 || dropped.is_multiple_of(100) {
                log::warn!(
                    "MacRecordingSession: {source} queue rejected {dropped} chunks ({error:?})"
                );
            }
        }
    }
}

pub struct KiriStreamDelegateIvars {
    state: Arc<DelegateState>,
}

objc2::define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    #[name = "KiriStreamDelegate"]
    #[ivars = KiriStreamDelegateIvars]
    pub struct KiriStreamDelegate;

    unsafe impl NSObjectProtocol for KiriStreamDelegate {}

    unsafe impl SCStreamOutput for KiriStreamDelegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_didOutputSampleBuffer_ofType(
            &self,
            _stream: &SCStream,
            buffer: &CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if !unsafe { buffer.data_is_ready() } {
                return;
            }
            let state = &self.ivars().state;
            // Late callbacks retain the delegate and its Arc-owned state, but
            // do not forward more data once stop begins.
            if state.stopped.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            let Some(senders) = state.senders.upgrade() else {
                return;
            };
            if of_type == SCStreamOutputType::Screen {
                if let Some(frame) = copy_pixel_buffer(buffer) {
                    let count = state
                        .frames
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                        + 1;
                    if count.is_multiple_of(30) {
                        log::info!("MacRecordingSession: {count} frames captured");
                    }
                    if let Err(mpsc::TrySendError::Full(_)) = senders.video_tx.try_send(frame) {
                        let dropped = state
                            .dropped_frames
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                            + 1;
                        if dropped == 1 || dropped.is_multiple_of(30) {
                            log::warn!(
                                "MacRecordingSession: encoder backpressure dropped {dropped} frames"
                            );
                        }
                    }
                }
            } else if of_type == SCStreamOutputType::Microphone {
                if let Some(tx) = &senders.mic_tx {
                    match state.mic_normalizer.lock().unwrap().convert(buffer) {
                        Ok(payload) if !payload.is_empty() => {
                            forward_audio_chunk(tx, payload, &state.dropped_mic_chunks, "microphone");
                        }
                        Ok(_) => {}
                        Err(error) => {
                            state.capture_health.report_unexpected_stop(format!("Microphone audio conversion failed: {error}"));
                        }
                    }
                }
            } else if let Some(tx) = &senders.audio_tx {
                let format = state.audio_format.get_or_init(|| {
                    let format = audio_format_from(buffer).unwrap_or(AudioFormat {
                        channels: 2,
                        is_float: true,
                        is_non_interleaved: false,
                    });
                    log::info!(
                        "MacRecordingSession: system audio format ch={} float={} non_interleaved={}",
                        format.channels,
                        format.is_float,
                        format.is_non_interleaved,
                    );
                    format
                });
                if let Some(bytes) = copy_audio_buffer(buffer) {
                    let payload = if format.is_float && format.is_non_interleaved {
                        deinterleave_f32(&bytes, format.channels, *format)
                    } else {
                        bytes
                    };
                    forward_audio_chunk(tx, payload, &state.dropped_audio_chunks, "system audio");
                }
            }
        }
    }

    unsafe impl SCStreamDelegate for KiriStreamDelegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_didStopWithError(&self, _stream: &SCStream, error: &NSError) {
            let message = error.localizedDescription().to_string();
            if self
                .ivars()
                .state
                .capture_health
                .report_unexpected_stop(message.clone())
            {
                log::error!(
                    "MacRecordingSession: ScreenCaptureKit stopped unexpectedly: {message}"
                );
            }
        }
    }
);

impl KiriStreamDelegate {
    fn with_state(state: Arc<DelegateState>) -> Retained<Self> {
        let this = KiriStreamDelegate::alloc().set_ivars(KiriStreamDelegateIvars { state });
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(test)]
mod recording_lifetime_tests {
    use super::*;

    #[test]
    fn native_delegate_owns_callback_state_and_frame_senders() {
        let (video_tx, video_rx) = mpsc::sync_channel(crate::capture::VIDEO_FRAME_QUEUE_CAPACITY);
        let senders = Arc::new(DelegateSenders {
            video_tx,
            audio_tx: None,
            mic_tx: None,
        });
        let state = Arc::new(DelegateState {
            senders: Arc::downgrade(&senders),
            capture_health: Arc::new(CaptureHealth::default()),
            audio_format: OnceLock::new(),
            mic_normalizer: std::sync::Mutex::new(audio::MicrophoneNormalizer::default()),
            stopped: std::sync::atomic::AtomicBool::new(false),
            frames: std::sync::atomic::AtomicU64::new(0),
            dropped_frames: std::sync::atomic::AtomicU64::new(0),
            dropped_audio_chunks: std::sync::atomic::AtomicU64::new(0),
            dropped_mic_chunks: std::sync::atomic::AtomicU64::new(0),
        });
        let weak_state = Arc::downgrade(&state);
        let delegate = KiriStreamDelegate::with_state(state.clone());

        drop(state);
        assert!(weak_state.upgrade().is_some());
        assert!(matches!(
            video_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        drop(senders);
        assert!(weak_state.upgrade().is_some());
        assert!(matches!(
            video_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));

        drop(delegate);
        assert!(weak_state.upgrade().is_none());
    }
}

// ---------------------------------------------------------------------------
// Scrolling capture: native image stream, independent of recording and audio.
// ---------------------------------------------------------------------------

struct MacScrollSession {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<std::result::Result<(), String>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl super::scroll::NativeScrollSource for MacScrollSession {
    fn stop(&mut self) -> Result<()> {
        if self.thread.is_none() {
            return Ok(());
        }
        let _ = self.stop_tx.send(());
        let result = self.done_rx.recv_timeout(Duration::from_secs(8));
        // Never turn a native timeout into an unbounded join. The stream thread
        // keeps ownership until its cleanup finishes, including late callbacks.
        let thread = self.thread.take().unwrap();
        match result {
            Ok(result) => {
                thread
                    .join()
                    .map_err(|_| anyhow!("Scrolling capture cleanup failed."))?;
                result.map_err(|message| anyhow!(message))
            }
            Err(_) => {
                drop(thread);
                bail!("Scrolling capture cleanup timed out.")
            }
        }
    }
}

#[derive(Default)]
struct ScrollMetrics {
    frames: u64,
    geometry: Duration,
    copy: Duration,
    slowest: Duration,
    last_report: Option<std::time::Instant>,
}

impl ScrollMetrics {
    fn record(&mut self, geometry: Duration, copy: Duration) {
        self.frames += 1;
        self.geometry += geometry;
        self.copy += copy;
        self.slowest = self.slowest.max(geometry + copy);
        let now = std::time::Instant::now();
        let last = self.last_report.get_or_insert(now);
        if last.elapsed() >= Duration::from_secs(3) {
            self.report();
            self.last_report = Some(now);
        }
    }

    fn report(&self) {
        if self.frames == 0 {
            return;
        }
        log::debug!(
            "[scroll] native frames={} geometry_mean_ms={:.3} copy_mean_ms={:.3} slowest_ms={:.3}",
            self.frames,
            self.geometry.as_secs_f64() * 1000.0 / self.frames as f64,
            self.copy.as_secs_f64() * 1000.0 / self.frames as f64,
            self.slowest.as_secs_f64() * 1000.0
        );
    }
}

struct ScrollDelegateState {
    target: super::scroll::ScrollTarget,
    metrics: std::sync::Mutex<ScrollMetrics>,
    sender: std::sync::Mutex<Option<super::scroll_frames::ScrollFrameSender>>,
    health: Arc<CaptureHealth>,
    width: u32,
    height: u32,
    stopped: std::sync::atomic::AtomicBool,
}

struct KiriScrollDelegateIvars {
    state: Arc<ScrollDelegateState>,
}

objc2::define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = AnyThread]
    #[name = "KiriScrollStreamDelegate"]
    #[ivars = KiriScrollDelegateIvars]
    struct KiriScrollStreamDelegate;
    unsafe impl NSObjectProtocol for KiriScrollStreamDelegate {}
    unsafe impl SCStreamOutput for KiriScrollStreamDelegate {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn scroll_output(
            &self,
            _stream: &SCStream,
            buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            let state = &self.ivars().state;
            if output_type != SCStreamOutputType::Screen
                || state.stopped.load(std::sync::atomic::Ordering::Acquire)
                || !unsafe { buffer.data_is_ready() }
                || !scroll_sample_is_complete(buffer)
                || state.health.unexpected_failure().is_some()
            {
                return;
            }
            let captured_at = std::time::Instant::now();
            if let Err(error) = scroll_window::validate(state.target) {
                state.health.report_capture_failure(error.to_string());
                return;
            }
            let geometry_time = captured_at.elapsed();
            let copy_started = std::time::Instant::now();
            let Some(pixel_buffer) = (unsafe { buffer.image_buffer() }) else {
                return;
            };
            let width = CVPixelBufferGetWidth(&pixel_buffer);
            let height = CVPixelBufferGetHeight(&pixel_buffer);
            if width != state.width as usize || height != state.height as usize {
                state.health.report_capture_failure(
                    "The scrolling capture display dimensions changed.".into(),
                );
                return;
            }
            if let Some(frame) = copy_scroll_pixel_buffer(&pixel_buffer, width, height) {
                if log::log_enabled!(log::Level::Debug) {
                    state
                        .metrics
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .record(geometry_time, copy_started.elapsed());
                }
                if let Some(sender) = state
                    .sender
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                {
                    sender.send(frame, state.width, state.height, captured_at);
                }
            } else {
                state.health.report_capture_failure(
                    "Scrolling capture could not read a complete native frame.".into(),
                );
            }
        }
    }
    unsafe impl SCStreamDelegate for KiriScrollStreamDelegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn scroll_stopped(&self, _stream: &SCStream, error: &NSError) {
            self.ivars()
                .state
                .health
                .report_unexpected_stop(error.localizedDescription().to_string());
        }
    }
);

impl KiriScrollStreamDelegate {
    fn with_state(state: Arc<ScrollDelegateState>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(KiriScrollDelegateIvars { state });
        unsafe { msg_send![super(this), init] }
    }
}

fn copy_scroll_pixel_buffer(
    buffer: &CVPixelBuffer,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    let row_bytes = width.checked_mul(4)?;
    let length = row_bytes.checked_mul(height)?;
    if length > super::scroll_frames::MAX_QUEUE_BYTES / 2 {
        return None;
    }
    if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) } != 0 {
        return None;
    }
    let result = (|| {
        let base = CVPixelBufferGetBaseAddress(buffer);
        let stride = CVPixelBufferGetBytesPerRow(buffer);
        if base.is_null() || stride < row_bytes {
            return None;
        }
        let mut pixels = Vec::with_capacity(length);
        for row in 0..height {
            let offset = row.checked_mul(stride)?;
            pixels.extend_from_slice(unsafe {
                std::slice::from_raw_parts(base.add(offset).cast::<u8>(), row_bytes)
            });
        }
        Some(pixels)
    })();
    unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) };
    result
}

fn scroll_sample_is_complete(buffer: &CMSampleBuffer) -> bool {
    let Some(attachments) = (unsafe { buffer.sample_attachments_array(false) }) else {
        return false;
    };
    if attachments.count() == 0 {
        return false;
    }
    // SCK supplies a CFDictionary toll-free bridged to NSDictionary. A missing,
    // idle, blank, or suspended frame is not new image evidence.
    let dictionary =
        unsafe { &*(attachments.value_at_index(0) as *const NSDictionary<NSString, NSObject>) };
    dictionary
        .objectForKey(unsafe { objc2_screen_capture_kit::SCStreamFrameInfoStatus })
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .is_some_and(|status| {
            status.integerValue() == objc2_screen_capture_kit::SCFrameStatus::Complete.0
        })
}

fn validate_scroll_display_at_stop(display_id: u32, frame: Rect, scale: f64) -> Result<()> {
    let (sender, receiver) = mpsc::channel();
    dispatch2::run_on_main(move |main| {
        let current = NSScreen::screens(main)
            .iter()
            .filter_map(|screen| screen_geometry(&screen).ok())
            .find(|screen| screen.display_id == display_id);
        let valid = current.is_some_and(|screen| {
            validate_recording_geometry(frame, scale, screen.frame, screen.backing_scale).is_ok()
        });
        let _ = sender.send(valid);
    });
    if receiver.recv_timeout(Duration::from_secs(2)) != Ok(true) {
        bail!("The selected display could not be verified before finishing scrolling capture.");
    }
    Ok(())
}

/// Resolve a one-window inclusion filter without ever waiting on the main
/// thread. The display-based filter keeps sourceRect in display coordinates;
/// independent-window capture can ignore sourceRect and scale after a resize.
fn scroll_source_snapshot(
    display_id: u32,
    expected_frame: Rect,
    scale: f64,
    selection: Rect,
    bound_target: Option<super::scroll::ScrollTarget>,
) -> Result<(Option<RecordingFilterPointer>, super::scroll::ScrollTarget)> {
    if MainThreadMarker::new().is_some() {
        bail!("Scrolling filter preparation must not block the main thread.");
    }
    let (tx, rx) = mpsc::channel::<
        std::result::Result<(Option<RecordingFilterPointer>, super::scroll::ScrollTarget), String>,
    >();
    dispatch2::run_on_main(move |_main| {
        let block = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                if !error.is_null() {
                    let error = unsafe { Retained::retain(error).unwrap() };
                    let _ = tx.send(Err(error.localizedDescription().to_string()));
                    return;
                }
                let Some(content) = (unsafe { Retained::retain(content) }) else {
                    let _ = tx.send(Err("The scrolling capture source is unavailable.".into()));
                    return;
                };
                let pointer = Retained::into_raw(content) as usize;
                let tx = tx.clone();
                dispatch2::run_on_main(move |main| {
                    let result =
                        (|| -> Result<(Option<RecordingFilterPointer>, super::scroll::ScrollTarget)> {
                            let content =
                                unsafe { Retained::from_raw(pointer as *mut SCShareableContent) }
                                    .ok_or_else(|| {
                                    anyhow!("The scrolling capture source is unavailable.")
                                })?;
                            let current = NSScreen::screens(main)
                                .iter()
                                .filter_map(|screen| screen_geometry(&screen).ok())
                                .find(|screen| screen.display_id == display_id)
                                .ok_or_else(|| {
                                    anyhow!("The selected display is no longer available.")
                                })?;
                            validate_recording_geometry(
                                expected_frame,
                                scale,
                                current.frame,
                                current.backing_scale,
                            )?;
                            let display = unsafe { content.displays() }
                                .iter()
                                .find(|display| unsafe { display.displayID() } == display_id)
                                .ok_or_else(|| {
                                    anyhow!("The selected display is no longer available.")
                                })?;
                            let (window, target) = scroll_window::resolve(
                                &content,
                                selection,
                                bound_target,
                            )?;
                            let filter = bound_target.map(|_| {
                                let filter = unsafe {
                                    SCContentFilter::initWithDisplay_includingWindows(
                                        SCContentFilter::alloc(),
                                        &display,
                                        &NSArray::from_slice(&[&*window]),
                                    )
                                };
                                RecordingFilterPointer(Some(Retained::into_raw(filter) as usize))
                            });
                            log::debug!(
                                "[scroll] source target={target:?} display={display_id} bound={}",
                                bound_target.is_some()
                            );
                            Ok((filter, target))
                        })()
                        .map_err(|error| error.to_string());
                    let _ = tx.send(result);
                });
            },
        );
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false, true, &block,
            );
        }
    });
    rx.recv_timeout(Duration::from_secs(8))
        .map_err(|_| anyhow!("Scrolling source lookup timed out."))?
        .map_err(|message| anyhow!(message))
}

pub(crate) fn resolve_scroll_target(
    display: &CapturedDisplay,
    region: super::scroll::PixelRegion,
) -> Result<super::scroll::ScrollTarget> {
    let (_, target) = scroll_source_snapshot(
        display.display_id,
        display.screen_frame,
        display.backing_scale,
        scroll_global_selection(display, region),
        None,
    )?;
    Ok(target)
}

fn scroll_global_selection(display: &CapturedDisplay, region: super::scroll::PixelRegion) -> Rect {
    let scale = display.backing_scale;
    Rect::new(
        display.screen_frame.x + region.x as f64 / scale,
        display.screen_frame.y + region.y as f64 / scale,
        region.width as f64 / scale,
        region.height as f64 / scale,
    )
}

pub(crate) fn start_scroll_source(
    display: &CapturedDisplay,
    region: super::scroll::PixelRegion,
    bound_target: super::scroll::ScrollTarget,
    sender: super::scroll_frames::ScrollFrameSender,
    health: Arc<CaptureHealth>,
) -> Result<(
    Box<dyn super::scroll::NativeScrollSource>,
    super::scroll::ScrollTarget,
)> {
    let (filter, target) = scroll_source_snapshot(
        display.display_id,
        display.screen_frame,
        display.backing_scale,
        scroll_global_selection(display, region),
        Some(bound_target),
    )?;
    let filter = filter.ok_or_else(|| anyhow!("The scrolling capture source is unavailable."))?;
    let display_id = display.display_id;
    let expected_frame = display.screen_frame;
    let scale = display.backing_scale;
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<(), String>>();
    let (done_tx, done_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("kiri-scroll-sck".into())
        .spawn(move || {
            let filter =
                unsafe { Retained::from_raw(filter.into_raw() as *mut SCContentFilter).unwrap() };
            let configuration = unsafe {
                let config = SCStreamConfiguration::new();
                config.setSourceRect(CGRect {
                    origin: CGPoint {
                        x: region.x as f64 / scale,
                        y: region.y as f64 / scale,
                    },
                    size: CGSize {
                        width: region.width as f64 / scale,
                        height: region.height as f64 / scale,
                    },
                });
                config.setWidth(region.width as usize);
                config.setHeight(region.height as usize);
                config.setMinimumFrameInterval(CMTime {
                    value: 1,
                    timescale: 60,
                    flags: objc2_core_media::CMTimeFlags(1),
                    epoch: 0,
                });
                config.setQueueDepth(3);
                config.setPixelFormat(0x4247_5241);
                config
                    .setCaptureResolution(objc2_screen_capture_kit::SCCaptureResolutionType::Best);
                config.setScalesToFit(false);
                config.setShowsCursor(false);
                // Mouse-click highlighting is off by default. Its setter is
                // macOS 15+, so do not send that selector on supported macOS 14.
                config.setCapturesAudio(false);
                config
            };
            let state = Arc::new(ScrollDelegateState {
                target,
                metrics: std::sync::Mutex::new(ScrollMetrics::default()),
                sender: std::sync::Mutex::new(Some(sender)),
                health: Arc::clone(&health),
                width: region.width,
                height: region.height,
                stopped: std::sync::atomic::AtomicBool::new(false),
            });
            let delegate = KiriScrollStreamDelegate::with_state(Arc::clone(&state));
            let queue = dispatch2::DispatchQueue::new("io.yuxino.kiri.scroll", None);
            let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*delegate);
            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &configuration,
                    Some(ProtocolObject::from_ref(&*delegate)),
                )
            };
            let registration = unsafe {
                stream.addStreamOutput_type_sampleHandlerQueue_error(
                    output,
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
            };
            if let Err(error) = registration {
                let _ = ready_tx.send(Err(format!("{error:?}")));
                return;
            }
            if let Err(error) = start_capture_sync(&stream) {
                let _ =
                    remove_stream_outputs(&stream, output, &queue, &[SCStreamOutputType::Screen]);
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            let geometry_check_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
            loop {
                match stop_rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if health.unexpected_failure().is_some() {
                    break;
                }
                // SCK can become idle when the window is minimized. The
                // periodic check also catches geometry loss without new frames.
                if let Err(error) = scroll_window::validate(target) {
                    health.report_capture_failure(error.to_string());
                    break;
                }
                if !geometry_check_pending.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    let health = Arc::clone(&health);
                    let pending = Arc::clone(&geometry_check_pending);
                    dispatch2::run_on_main(move |main| {
                        let current = NSScreen::screens(main)
                            .iter()
                            .filter_map(|screen| screen_geometry(&screen).ok())
                            .find(|screen| screen.display_id == display_id);
                        if current.is_none_or(|current| {
                            validate_recording_geometry(
                                expected_frame,
                                scale,
                                current.frame,
                                current.backing_scale,
                            )
                            .is_err()
                        }) {
                            health.report_capture_failure(
                                "The selected display changed. Start a new scrolling capture."
                                    .into(),
                            );
                        }
                        pending.store(false, std::sync::atomic::Ordering::Release);
                    });
                }
            }
            // First detach the output and drain its serial callback queue.
            // A finalization must retain already delivered tail frames, unlike
            // recorder shutdown which can discard late encoder callbacks.
            let result =
                remove_stream_outputs(&stream, output, &queue, &[SCStreamOutputType::Screen])
                    .and_then(|()| {
                        validate_scroll_display_at_stop(display_id, expected_frame, scale)
                    })
                    .and_then(|()| scroll_window::validate(target));
            state
                .metrics
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .report();
            state
                .stopped
                .store(true, std::sync::atomic::Ordering::Release);
            state
                .sender
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            drop(stream);
            drop(delegate);
            drop(queue);
            let _ = done_tx.send(result.map_err(|error| error.to_string()));
        })?;
    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok((
            Box::new(MacScrollSession {
                stop_tx,
                done_rx,
                thread: Some(thread),
            }),
            target,
        )),
        Ok(Err(error)) => {
            let _ = stop_tx.send(());
            Err(anyhow!(error))
        }
        Err(_) => {
            let _ = stop_tx.send(());
            bail!("Scrolling capture startup timed out.")
        }
    }
}
