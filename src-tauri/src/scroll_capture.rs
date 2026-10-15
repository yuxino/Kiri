//! A native frame stream and one conservative, local scrolling-capture session.
//! The hidden selection overlay remains the capture/library ownership lease.
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

use base64::Engine;
use image::{ImageEncoder, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use crate::capture::{CapturedDisplay, PlatformRecorder};
use crate::commands::RectDto;
use crate::core::geometry::Rect;
use crate::core::scroll_stitch::{ScrollStitcher, StitchUpdate};
use crate::platform::{self, TransientWindowRole};
use crate::state::AppState;

pub(crate) const PANEL: &str = "scroll-capture";
const IDLE: u8 = 0;
const FINISHING: u8 = 1;
const SAVING: u8 = 2;
const CANCELLED: u8 = 3;

#[derive(Default)]
pub struct ScrollCaptureState {
    session: Mutex<Option<Arc<Session>>>,
    /// Serialize OS shortcut ownership with publishing/removing generations.
    /// The plugin callback reads only `session`, never this lifecycle lock.
    lifecycle: Mutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureStatus {
    session_id: String,
    phase: &'static str,
    width: u32,
    height: u32,
    frames: u32,
    revision: u64,
    message: Option<String>,
    preview: Option<String>,
}

struct Session {
    id: uuid::Uuid,
    capture_id: uuid::Uuid,
    status: Mutex<ScrollCaptureStatus>,
    control: mpsc::Sender<Control>,
    action: AtomicU8,
    cancelled: AtomicBool,
    output: Mutex<Option<PreparedOutput>>,
}

struct StartupGuard {
    app: AppHandle,
    owner: WebviewWindow,
    id: uuid::Uuid,
    capture_id: uuid::Uuid,
    armed: bool,
}

impl Drop for StartupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let scroll = self.app.state::<ScrollCaptureState>();
        let lifecycle = scroll.lifecycle.lock().unwrap();
        let Some(session) = current(&self.app).filter(|session| session.id == self.id) else {
            return;
        };
        // The cancel worker is waiting for this startup's control receiver to
        // drop. It owns teardown; do not resurrect the original selection.
        if session.cancelled.load(Ordering::Acquire) {
            return;
        }
        // Clear before closing: a failed helper's Destroyed callback must not
        // cancel the still-valid screenshot selection during rollback.
        let _ = self.app.global_shortcut().unregister(escape());
        clear(&self.app, self.id);
        drop(lifecycle);
        if let Some(panel) = self.app.get_webview_window(PANEL) {
            let _ = panel.close();
        }
        let state = self.app.state::<AppState>();
        let restore = {
            let mut capture = state.capture.lock().unwrap();
            capture
                .session
                .as_mut()
                .filter(|capture| capture.capture_id == self.capture_id)
                .map(|capture| {
                    capture.overlay_labels.retain(|label| label != PANEL);
                })
                .is_some()
        };
        if restore {
            let _ = self.owner.show();
            let _ = self.owner.set_focus();
        }
    }
}

#[derive(Clone)]
struct PreparedOutput {
    png: Arc<[u8]>,
    size: (u32, u32),
}

enum Control {
    Finish {
        allow_partial: bool,
        reply: mpsc::Sender<Result<PreparedOutput, String>>,
    },
    Cancel(mpsc::Sender<()>),
}

fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

pub fn active(app: &AppHandle) -> bool {
    app.try_state::<ScrollCaptureState>()
        .is_some_and(|state| state.session.lock().unwrap().is_some())
}

fn current(app: &AppHandle) -> Option<Arc<Session>> {
    app.try_state::<ScrollCaptureState>()?
        .session
        .lock()
        .unwrap()
        .clone()
}

fn owned(window: &WebviewWindow, id: &str) -> Result<Arc<Session>, String> {
    if window.label() != PANEL {
        return Err("This command is unavailable from this window.".into());
    }
    current(window.app_handle())
        .filter(|session| session.id.to_string() == id)
        .ok_or_else(|| "This scrolling capture is no longer active.".into())
}

#[tauri::command]
pub fn scroll_capture_supported() -> bool {
    crate::capture::scroll::supported()
}

#[tauri::command]
pub fn scroll_capture_status(
    window: WebviewWindow,
    session_id: String,
) -> Result<ScrollCaptureStatus, String> {
    let session = owned(&window, &session_id)?;
    let status = session.status.lock().unwrap().clone();
    Ok(status)
}

/// Execute native presentation on GTK/AppKit's thread, or on the existing
/// serial Windows presenter, while keeping the async IPC callback responsive.
fn present<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    let task = move || {
        let _ = tx.send(task());
    };
    #[cfg(windows)]
    crate::window_tasks::dispatch(task)?;
    #[cfg(not(windows))]
    app.run_on_main_thread(task)
        .map_err(|error| error.to_string())?;
    // Do not abandon queued window creation: its result owns startup cleanup.
    rx.recv()
        .map_err(|_| "Could not prepare scrolling capture.".to_string())?
}

fn intersects(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn panel_frame(bounds: Rect, selection: Rect) -> Option<Rect> {
    for (width, height) in [(272.0, 500.0), (240.0, 260.0)] {
        for (x, y) in [
            (selection.x + selection.width + 8.0, selection.y),
            (selection.x - width - 8.0, selection.y),
            (selection.x, selection.y + selection.height + 8.0),
            (selection.x, selection.y - height - 8.0),
        ] {
            if width > bounds.width - 16.0 || height > bounds.height - 16.0 {
                continue;
            }
            let frame = Rect::new(
                x.clamp(bounds.x + 8.0, bounds.x + bounds.width - width - 8.0),
                y.clamp(bounds.y + 8.0, bounds.y + bounds.height - height - 8.0),
                width,
                height,
            );
            if !intersects(frame, selection) {
                return Some(frame);
            }
        }
    }
    None
}

fn validate_selection(display: &CapturedDisplay, selection: Rect) -> Result<(), String> {
    if ![selection.x, selection.y, selection.width, selection.height]
        .iter()
        .all(|value| value.is_finite())
        || selection.x < 0.0
        || selection.y < 0.0
        || selection.width < 16.0
        || selection.height < 32.0
        || selection.x + selection.width > display.screen_frame.width + 0.01
        || selection.y + selection.height > display.screen_frame.height + 0.01
    {
        return Err("Select a larger scrolling content area.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    selection: RectDto,
) -> Result<ScrollCaptureStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_inner(window, app, selection))
        .await
        .map_err(|error| error.to_string())?
}

fn start_inner(
    window: WebviewWindow,
    app: AppHandle,
    selection: RectDto,
) -> Result<ScrollCaptureStatus, String> {
    if !crate::capture::scroll::supported() {
        return Err("Scrolling capture is not available on this desktop.".into());
    }
    let state = app.state::<AppState>();
    let _transition = state.library_transition.lock().unwrap();
    let (capture_id, display, return_pid) = {
        let capture = state.capture.lock().unwrap();
        let session = capture
            .session
            .as_ref()
            .filter(|session| {
                session
                    .overlay_labels
                    .iter()
                    .any(|label| label == window.label())
            })
            .ok_or("Capture command is only available to its overlay.")?;
        if session.annotation.is_some() {
            return Err(
                "Finish the current annotations before starting a scrolling capture.".into(),
            );
        }
        (
            session.capture_id,
            session.display.clone(),
            session.return_pid,
        )
    };
    // Retrying within the same frozen selection is a new scroll generation.
    let id = uuid::Uuid::new_v4();
    let region = Rect::new(selection.x, selection.y, selection.width, selection.height);
    validate_selection(&display, region)?;
    let (width, height) =
        crate::capture::scroll::dimensions(&display, region).map_err(|error| error.to_string())?;
    // Validate the full initial allocation before hiding the user's selection.
    ScrollStitcher::new(width, height).map_err(|error| error.to_string())?;
    let (control, receiver) = mpsc::channel();
    let session = Arc::new(Session {
        id,
        capture_id,
        status: Mutex::new(ScrollCaptureStatus {
            session_id: id.to_string(),
            phase: "starting",
            width,
            height,
            frames: 0,
            revision: 0,
            preview: None,
            message: None,
        }),
        control,
        action: AtomicU8::new(IDLE),
        cancelled: AtomicBool::new(false),
        output: Mutex::new(None),
    });
    let scroll = app.state::<ScrollCaptureState>();
    let lifecycle = scroll.lifecycle.lock().unwrap();
    {
        let mut slot = scroll.session.lock().unwrap();
        if slot.is_some() {
            return Err("A scrolling capture is already active.".into());
        }
        *slot = Some(Arc::clone(&session));
    }
    // Bare Esc is owned only by this session. Never modify the user's capture
    // shortcut and never unregister from the plugin's locked callback.
    if app.global_shortcut().is_registered(escape())
        || app.global_shortcut().register(escape()).is_err()
    {
        clear(&app, id);
        return Err("Escape is unavailable. Close the other capture tool and try again.".into());
    }
    let mut startup = StartupGuard {
        app: app.clone(),
        owner: window.clone(),
        id,
        capture_id,
        armed: true,
    };
    drop(lifecycle);
    // CaptureSession remains the library lease. Do not keep the transition
    // mutex while waiting for a native UI callback on GTK/AppKit.
    drop(_transition);
    let target = app.clone();
    let selected_display = display.clone();
    let owner = window.clone();
    let prepared = present(&app, move || {
        let screen = selected_display.screen_frame;
        let scale = selected_display.backing_scale;
        let bounds = owner
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| {
                let area = monitor.work_area();
                Rect::new(
                    f64::from(area.position.x) / scale,
                    f64::from(area.position.y) / scale,
                    f64::from(area.size.width) / scale,
                    f64::from(area.size.height) / scale,
                )
            })
            .unwrap_or(screen);
        let selected = Rect::new(
            screen.x + region.x,
            screen.y + region.y,
            region.width,
            region.height,
        );
        let frame = panel_frame(bounds, selected)
            .ok_or("Leave space beside the selection for scrolling capture controls.")?;
        let panel = WebviewWindowBuilder::new(
            &target,
            PANEL,
            WebviewUrl::App(format!("index.html?window=scroll-capture&sessionId={id}").into()),
        )
        .title("Kiri")
        .position(frame.x, frame.y)
        .inner_size(frame.width, frame.height)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| error.to_string())?;
        (|| {
            platform::place_transient_window(&panel, frame, scale)
                .map_err(|error| error.to_string())?;
            platform::configure_transient_window(&panel, TransientWindowRole::RecordingControls);
            platform::set_window_capture_excluded(&target, PANEL, true);
            #[cfg(target_os = "linux")]
            platform::linux::hide_window_for_capture(&owner).map_err(|error| error.to_string())?;
            #[cfg(windows)]
            platform::windows::hide_window_for_capture(&owner)
                .map_err(|error| error.to_string())?;
            #[cfg(target_os = "macos")]
            owner.hide().map_err(|error| error.to_string())?;
            platform::show_window_without_activation(
                &target,
                PANEL,
                TransientWindowRole::RecordingControls,
            );
            if let Some(pid) = return_pid {
                platform::activate_application(pid);
            }
            Ok(())
        })()
    });
    prepared?;
    if session.cancelled.load(Ordering::Acquire) {
        return Err("Capture canceled.".into());
    }
    {
        let mut capture = state.capture.lock().unwrap();
        let capture = capture
            .session
            .as_mut()
            .filter(|capture| capture.capture_id == capture_id)
            .ok_or("This scrolling capture is no longer active.")?;
        capture.overlay_labels.push(PANEL.into());
    }
    let worker_session = Arc::clone(&session);
    let spawned = std::thread::Builder::new()
        .name("kiri-scroll-capture".into())
        .spawn(move || {
            let failed_session = Arc::clone(&worker_session);
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_worker(worker_session, display, region, width, height, receiver);
            }))
            .is_err()
            {
                fail(
                    &failed_session,
                    "The scrolling capture worker stopped unexpectedly.",
                );
            }
        });
    if let Err(error) = spawned {
        return Err(error.to_string());
    }
    startup.armed = false;
    let status = session.status.lock().unwrap().clone();
    Ok(status)
}

fn png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    image::codecs::png::PngEncoder::new(&mut data)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(data)
}

fn refresh(session: &Session, stitcher: &ScrollStitcher, update: StitchUpdate) {
    let mut status = session.status.lock().unwrap();
    let (width, height) = stitcher.dimensions();
    status.width = width;
    status.height = height;
    status.frames = stitcher.frame_count();
    status.revision += 1;
    match update {
        StitchUpdate::NeedsOverlap => {
            status.phase = "needsOverlap";
            status.message = Some("Scroll back slightly to reconnect the screenshot.".into());
        }
        StitchUpdate::LimitReached => {
            status.phase = "needsOverlap";
            status.message = Some("The screenshot reached its size limit.".into());
        }
        _ => {
            status.phase = "capturing";
            status.message = Some("Scroll down slowly to extend the screenshot.".into());
        }
    }
    if matches!(
        update,
        StitchUpdate::Started | StitchUpdate::Appended { .. }
    ) {
        if let Some(image) = stitcher.preview(248, 360) {
            if let Ok(bytes) = png(&image) {
                status.preview = Some(format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ));
            }
        }
    }
}

fn fail(session: &Session, error: &str) {
    log::warn!("scroll capture: {error}");
    let mut status = session.status.lock().unwrap();
    status.phase = "failed";
    status.message = Some("Screen capture stopped. Save the captured portion or cancel.".into());
    status.revision += 1;
}

fn run_worker(
    session: Arc<Session>,
    display: CapturedDisplay,
    region: Rect,
    width: u32,
    height: u32,
    controls: mpsc::Receiver<Control>,
) {
    if session.cancelled.load(Ordering::Acquire) {
        return;
    }
    let mut stitcher = match ScrollStitcher::new(width, height) {
        Ok(stitcher) => stitcher,
        Err(error) => {
            fail(&session, &error.to_string());
            return;
        }
    };
    let (tx, frames) = mpsc::sync_channel(crate::capture::VIDEO_FRAME_QUEUE_CAPACITY);
    let mut source = match crate::capture::scroll::start(&display, region, tx) {
        Ok(source) => Some(source),
        Err(error) => {
            fail(&session, &error.to_string());
            None
        }
    };
    let started = Instant::now();
    let mut prepared: Option<PreparedOutput> = None;
    loop {
        if session.cancelled.load(Ordering::Acquire) {
            break;
        }
        if let Ok(control) = controls.try_recv() {
            match control {
                Control::Cancel(reply) => {
                    if let Some(mut recorder) = source.take() {
                        let _ = recorder.stop();
                    }
                    let _ = reply.send(());
                    break;
                }
                Control::Finish {
                    allow_partial,
                    reply,
                } => {
                    let result = if let Some(output) = prepared.as_ref() {
                        Ok(output.clone())
                    } else {
                        prepare_output(
                            &session,
                            &mut stitcher,
                            &frames,
                            &mut source,
                            width,
                            allow_partial,
                        )
                    };
                    if let Ok(output) = &result {
                        prepared = Some(output.clone());
                    }
                    let _ = reply.send(result);
                }
            }
        }
        if let Some(recorder) = source.as_ref() {
            if let Some(error) = recorder.unexpected_failure() {
                fail(&session, &error);
                if let Some(mut recorder) = source.take() {
                    let _ = recorder.stop();
                }
            }
        }
        match frames.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) if source.is_some() && prepared.is_none() => {
                match stitcher.push_bgra(&bytes, width as usize * 4) {
                    Ok(update) => refresh(&session, &stitcher, update),
                    Err(error) => {
                        fail(&session, &error.to_string());
                        if let Some(mut recorder) = source.take() {
                            let _ = recorder.stop();
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if source.is_some() {
                    fail(&session, "The frame source disconnected.");
                    if let Some(mut recorder) = source.take() {
                        let _ = recorder.stop();
                    }
                }
                // A failed or sealed source still accepts Save/Cancel commands.
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if stitcher.frame_count() == 0
                    && started.elapsed() > Duration::from_secs(10)
                    && source.is_some()
                {
                    fail(&session, "No native frame arrived.");
                    if let Some(mut recorder) = source.take() {
                        let _ = recorder.stop();
                    }
                }
            }
        }
    }
    if let Some(mut recorder) = source.take() {
        let _ = recorder.stop();
    }
}

fn prepare_output(
    session: &Session,
    stitcher: &mut ScrollStitcher,
    frames: &mpsc::Receiver<Vec<u8>>,
    source: &mut Option<Box<dyn PlatformRecorder>>,
    width: u32,
    allow_partial: bool,
) -> Result<PreparedOutput, String> {
    if session.cancelled.load(Ordering::Acquire) {
        return Err("Capture canceled.".into());
    }
    // Capture the last visible viewport even when Done is clicked immediately
    // after a wheel tick. An unchanged settled pair or a quiet source ends this
    // bounded wait; no timer is allowed to invent a missing overlap.
    let started = Instant::now();
    let deadline = started + Duration::from_millis(650);
    let mut last_motion = started;
    let mut last_arrival = started;
    let mut stable_frames = 0;
    let mut settled = source.is_none();
    while source.is_some() && Instant::now() < deadline {
        if session.cancelled.load(Ordering::Acquire) {
            return Err("Capture canceled.".into());
        }
        match frames.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) => {
                let update = stitcher
                    .push_bgra(&bytes, width as usize * 4)
                    .map_err(|error| error.to_string())?;
                last_arrival = Instant::now();
                if matches!(update, StitchUpdate::Unchanged) {
                    stable_frames += 1;
                } else {
                    last_motion = last_arrival;
                    stable_frames = 0;
                }
                refresh(session, stitcher, update);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                fail(session, "The frame source disconnected during finishing.");
                if let Some(mut recorder) = source.take() {
                    let _ = recorder.stop();
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        if now.duration_since(started) >= Duration::from_millis(250)
            && now.duration_since(last_motion) >= Duration::from_millis(150)
            && (stable_frames >= 2
                || now.duration_since(last_arrival) >= Duration::from_millis(150))
        {
            settled = true;
            break;
        }
    }
    if !settled && !allow_partial && session.status.lock().unwrap().phase != "failed" {
        refresh(session, stitcher, StitchUpdate::NeedsOverlap);
        return Err("Scroll back slightly to reconnect the screenshot.".into());
    }
    let phase = session.status.lock().unwrap().phase;
    if !allow_partial && (phase == "needsOverlap" || phase == "failed") {
        return Err("Scroll back slightly to reconnect the screenshot.".into());
    }
    let image = stitcher
        .image()
        .ok_or("No scrolling screenshot has been captured yet.")?;
    if let Some(mut recorder) = source.take() {
        if let Err(error) = recorder.stop() {
            if !allow_partial {
                fail(session, &error.to_string());
                return Err(error.to_string());
            }
        }
    }
    Ok(PreparedOutput {
        size: image.dimensions(),
        png: png(&image)?.into(),
    })
}

fn clear(app: &AppHandle, id: uuid::Uuid) {
    let state = app.state::<ScrollCaptureState>();
    let mut slot = state.session.lock().unwrap();
    if slot.as_ref().is_some_and(|session| session.id == id) {
        slot.take();
    }
}

#[tauri::command]
pub async fn finish_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    session_id: String,
    allow_partial: bool,
) -> Result<(), String> {
    let session = owned(&window, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || finish_inner(&app, session, allow_partial))
        .await
        .map_err(|error| error.to_string())?
}

fn finish_inner(app: &AppHandle, session: Arc<Session>, allow_partial: bool) -> Result<(), String> {
    session
        .action
        .compare_exchange(IDLE, FINISHING, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "This scrolling capture is already finishing.".to_string())?;
    let output = if let Some(output) = session.output.lock().unwrap().clone() {
        Ok(output)
    } else {
        let (reply, response) = mpsc::channel();
        session
            .control
            .send(Control::Finish {
                allow_partial,
                reply,
            })
            .map_err(|_| "Screen capture stopped.".to_string())
            .and_then(|()| {
                response
                    .recv()
                    .map_err(|_| "Screen capture stopped.".to_string())
            })
            .and_then(|result| result)
    };
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = session.action.compare_exchange(
                FINISHING,
                IDLE,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return Err(error);
        }
    };
    *session.output.lock().unwrap() = Some(output.clone());
    session
        .action
        .compare_exchange(FINISHING, SAVING, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Capture canceled.".to_string())?;
    {
        let mut status = session.status.lock().unwrap();
        status.phase = "saving";
        status.revision += 1;
    }
    if let Err(error) =
        crate::commands::commit_scroll_capture(app, session.capture_id, &output.png, output.size)
    {
        session.action.store(IDLE, Ordering::Release);
        let mut status = session.status.lock().unwrap();
        status.phase = "failed";
        status.message = Some("Could not save the screenshot. Try again.".into());
        return Err(error);
    }
    session.cancelled.store(true, Ordering::Release);
    let scroll = app.state::<ScrollCaptureState>();
    let _lifecycle = scroll.lifecycle.lock().unwrap();
    let _ = app.global_shortcut().unregister(escape());
    clear(app, session.id);
    // The caller closes its panel after the IPC reply. Pending completion then
    // closes the hidden overlay and presents the normal saved-image card.
    Ok(())
}

#[tauri::command]
pub async fn cancel_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let session = owned(&window, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || cancel_inner(&app, session, false))
        .await
        .map_err(|error| error.to_string())?
}

fn cancel_inner(app: &AppHandle, session: Arc<Session>, close_panel: bool) -> Result<(), String> {
    if !current(app).is_some_and(|active| active.id == session.id) {
        session.cancelled.store(true, Ordering::Release);
        return Ok(());
    }
    loop {
        let action = session.action.load(Ordering::Acquire);
        if action == SAVING {
            return Err("The screenshot is being saved.".into());
        }
        if action == CANCELLED {
            return Ok(());
        }
        if session
            .action
            .compare_exchange(action, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            break;
        }
    }
    session.cancelled.store(true, Ordering::Release);
    let (reply, response) = mpsc::channel();
    if session.control.send(Control::Cancel(reply)).is_ok() {
        // Cancelled is also checked by the worker; channel closure acknowledges
        // that its final source stop completed even when it skipped this reply.
        let _ = response.recv();
    }
    let scroll = app.state::<ScrollCaptureState>();
    let lifecycle = scroll.lifecycle.lock().unwrap();
    if !current(app).is_some_and(|active| active.id == session.id) {
        return Ok(());
    }
    let _ = app.global_shortcut().unregister(escape());
    let state = app.state::<AppState>();
    let panel = if close_panel {
        app.get_webview_window(PANEL)
    } else {
        None
    };
    let capture = {
        let mut flow = state.capture.lock().unwrap();
        if flow
            .session
            .as_ref()
            .is_some_and(|capture| capture.capture_id == session.capture_id)
        {
            flow.session.take()
        } else {
            None
        }
    };
    clear(app, session.id);
    drop(lifecycle);
    if let Some(capture) = capture {
        for label in &capture.overlay_labels {
            if label != PANEL {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.close();
                }
            }
        }
        crate::commands::teardown_cancelled_capture(app, capture, false);
    }
    if let Some(panel) = panel {
        let _ = panel.close();
    }
    Ok(())
}

pub fn close_requested(app: &AppHandle, label: &str) -> bool {
    if label != PANEL {
        return false;
    }
    let Some(session) = current(app) else {
        return false;
    };
    if session.action.load(Ordering::Acquire) != SAVING {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = cancel_inner(&app, session, true);
        });
    }
    // Keep the IPC owner alive through a save. Other closes wait for native
    // capture teardown and then close only after the active slot is cleared.
    true
}

/// Called under the shortcut plugin's map lock. Dispatch without unregistering
/// or waiting here; the queued action remains bound to this exact generation.
pub fn handle_escape(app: &AppHandle, shortcut: &Shortcut) -> bool {
    if *shortcut != escape() {
        return false;
    }
    let Some(session) = current(app) else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = cancel_inner(&app, session, true);
    });
    true
}

pub fn focus_panel(app: &AppHandle) -> bool {
    if !active(app) {
        return false;
    }
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
    true
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if label != PANEL && label != "overlay" {
        return;
    }
    let Some(session) = current(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = cancel_inner(&app, session, true);
    });
}

pub fn shutdown(app: &AppHandle) {
    if let Some(session) = current(app) {
        session.cancelled.store(true, Ordering::Release);
        let _ = app.global_shortcut().unregister(escape());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{imageops::crop_imm, Rgba};
    use std::sync::atomic::AtomicUsize;

    struct TestRecorder {
        stops: Arc<AtomicUsize>,
        fail_stop: bool,
    }

    impl PlatformRecorder for TestRecorder {
        fn stop(&mut self) -> anyhow::Result<()> {
            self.stops.fetch_add(1, Ordering::AcqRel);
            if self.fail_stop {
                anyhow::bail!("The native capture failed while stopping.");
            }
            Ok(())
        }
    }

    fn test_recorder(fail_stop: bool) -> (Option<Box<dyn PlatformRecorder>>, Arc<AtomicUsize>) {
        let stops = Arc::new(AtomicUsize::new(0));
        (
            Some(Box::new(TestRecorder {
                stops: Arc::clone(&stops),
                fail_stop,
            })),
            stops,
        )
    }

    fn document() -> RgbaImage {
        RgbaImage::from_fn(83, 800, |x, y| {
            let seed = x.wrapping_mul(0x45d9f3b) ^ y.wrapping_mul(0x119de1f3);
            let value = seed.wrapping_mul(seed ^ 0x9e3779b9);
            Rgba([
                (value >> 24) as u8,
                (value >> 16) as u8,
                (value >> 8) as u8,
                255,
            ])
        })
    }

    fn viewport(document: &RgbaImage, y: u32) -> RgbaImage {
        crop_imm(document, 0, y, 83, 157).to_image()
    }

    fn bgra(image: &RgbaImage) -> Vec<u8> {
        image
            .as_raw()
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect()
    }

    fn started_capture(document: &RgbaImage) -> (Session, ScrollStitcher) {
        let id = uuid::Uuid::new_v4();
        let (control, _receiver) = mpsc::channel();
        let session = Session {
            id,
            capture_id: uuid::Uuid::new_v4(),
            status: Mutex::new(ScrollCaptureStatus {
                session_id: id.to_string(),
                phase: "starting",
                width: 83,
                height: 157,
                frames: 0,
                revision: 0,
                message: None,
                preview: None,
            }),
            control,
            action: AtomicU8::new(IDLE),
            cancelled: AtomicBool::new(false),
            output: Mutex::new(None),
        };
        let mut stitcher = ScrollStitcher::new(83, 157).unwrap();
        let update = stitcher.push(viewport(document, 0)).unwrap();
        refresh(&session, &stitcher, update);
        (session, stitcher)
    }

    fn decoded(output: &PreparedOutput) -> RgbaImage {
        image::load_from_memory(&output.png).unwrap().to_rgba8()
    }

    #[test]
    fn finishing_waits_for_the_latest_viewport_after_a_queued_unchanged_frame() {
        let document = document();
        let (session, mut stitcher) = started_capture(&document);
        let (mut source, stops) = test_recorder(false);
        let (sender, frames) = mpsc::channel();
        sender.send(bgra(&viewport(&document, 0))).unwrap();

        let latest = bgra(&viewport(&document, 80));
        let delayed_sender = sender.clone();
        let delayed_frame = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            // The old implementation sealed on the queued baseline and never
            // consumed this already-visible last scroll position.
            let _ = delayed_sender.send(latest);
        });
        let output =
            prepare_output(&session, &mut stitcher, &frames, &mut source, 83, false).unwrap();
        delayed_frame.join().unwrap();

        assert_eq!(output.size, (83, 237));
        assert_eq!(
            decoded(&output),
            crop_imm(&document, 0, 0, 83, 237).to_image()
        );
        assert!(source.is_none());
        assert_eq!(stops.load(Ordering::Acquire), 1);
    }

    #[test]
    fn a_missing_overlap_keeps_capture_live_until_a_recovered_viewport_arrives() {
        let document = document();
        let (session, mut stitcher) = started_capture(&document);
        let update = stitcher.push(viewport(&document, 400)).unwrap();
        assert_eq!(update, StitchUpdate::NeedsOverlap);
        refresh(&session, &stitcher, update);
        let (mut source, stops) = test_recorder(false);
        let (sender, frames) = mpsc::channel();

        assert!(prepare_output(&session, &mut stitcher, &frames, &mut source, 83, false).is_err());
        assert!(source.is_some());
        assert_eq!(stops.load(Ordering::Acquire), 0);
        assert_eq!(stitcher.dimensions(), (83, 157));

        sender.send(bgra(&viewport(&document, 80))).unwrap();
        let output =
            prepare_output(&session, &mut stitcher, &frames, &mut source, 83, false).unwrap();
        assert_eq!(
            decoded(&output),
            crop_imm(&document, 0, 0, 83, 237).to_image()
        );
        assert!(source.is_none());
        assert_eq!(stops.load(Ordering::Acquire), 1);
    }

    #[test]
    fn native_stop_failure_requires_explicit_partial_save_and_preserves_pixels() {
        let document = document();
        let (session, mut stitcher) = started_capture(&document);
        let (mut source, stops) = test_recorder(true);
        let (_sender, frames) = mpsc::channel();

        let result = prepare_output(&session, &mut stitcher, &frames, &mut source, 83, false);
        assert!(result.is_err());
        assert_eq!(session.status.lock().unwrap().phase, "failed");
        assert!(source.is_none());
        assert_eq!(stops.load(Ordering::Acquire), 1);

        let output =
            prepare_output(&session, &mut stitcher, &frames, &mut source, 83, true).unwrap();
        assert_eq!(decoded(&output), viewport(&document, 0));
        assert_eq!(stops.load(Ordering::Acquire), 1);
    }

    #[test]
    fn cancellation_rejects_finishing_before_consuming_any_queued_pixels() {
        let document = document();
        let (session, mut stitcher) = started_capture(&document);
        let (mut source, stops) = test_recorder(false);
        let (sender, frames) = mpsc::channel();
        sender.send(bgra(&viewport(&document, 80))).unwrap();
        session.cancelled.store(true, Ordering::Release);

        let result = prepare_output(&session, &mut stitcher, &frames, &mut source, 83, true);
        assert!(matches!(result, Err(error) if error == "Capture canceled."));
        assert_eq!(stitcher.image().unwrap(), viewport(&document, 0));
        assert!(frames.try_recv().is_ok());
        // The worker retains ownership of stopping the source after this
        // helper returns; finalization must not race a second stop path.
        assert!(source.is_some());
        assert_eq!(stops.load(Ordering::Acquire), 0);
    }

    #[test]
    fn controls_never_overlap_selected_pixels() {
        let bounds = Rect::new(-1280.0, 0.0, 1280.0, 900.0);
        for selection in [
            Rect::new(-1100.0, 80.0, 600.0, 700.0),
            Rect::new(-1200.0, 300.0, 1100.0, 220.0),
        ] {
            let panel = panel_frame(bounds, selection).unwrap();
            assert!(!intersects(panel, selection));
            assert!(panel.x >= bounds.x && panel.y >= bounds.y);
            assert!(panel.x + panel.width <= bounds.x + bounds.width);
            assert!(panel.y + panel.height <= bounds.y + bounds.height);
        }
        assert!(panel_frame(bounds, bounds).is_none());
    }

    #[test]
    fn too_small_display_does_not_create_unreachable_controls() {
        assert!(panel_frame(
            Rect::new(0.0, 0.0, 200.0, 250.0),
            Rect::new(10.0, 10.0, 60.0, 90.0)
        )
        .is_none());
    }
}
