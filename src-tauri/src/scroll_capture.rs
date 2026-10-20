//! Session ownership for continuous, user-driven scrolling screenshots.
//! Raw frames, stitching and PNG previews run independently of the UI thread.
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use image::{ImageFormat, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::capture::scroll::{self, ScrollSource};
use crate::capture::scroll_frames::ScrollFrame;
use crate::commands::RectDto;
use crate::core::geometry::Rect;
use crate::core::scroll_document::{ScrollDocument, ScrollUpdate};
use crate::platform::{self, TransientWindowRole};
use crate::state::{AppState, CaptureSession, CompletionPreviewDto};

const PANEL: &str = "scroll-capture";
const REGION: &str = "scroll-capture-region";
const RECONNECT: &str = "Return to captured content to continue.";
const SAVE_FAILED: &str = "Could not save scrolling capture. Try again.";
const INACTIVE: &str = "This scrolling capture is no longer active.";
const SOURCE_FAILED: &str = "Scrolling capture stopped. Save the captured area or cancel.";

#[derive(Default)]
pub(crate) struct ScrollCaptureState(Mutex<Option<Arc<Session>>>);
impl ScrollCaptureState {
    pub(crate) fn is_active(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }
    fn cancel_owned(&self, id: uuid::Uuid) {
        let Ok(session) = self.get(id) else { return };
        // Destruction during normal teardown must not turn a startup failure
        // into a user cancellation or affect a later session with the same label.
        if !session.closing.load(Ordering::Acquire) {
            let _ = session.requests.lock().unwrap().cancel();
        }
    }
    fn release_closed(&self, id: uuid::Uuid, windows_gone: bool) -> bool {
        if !windows_gone {
            return false;
        }
        let mut active = self.0.lock().unwrap();
        if active.as_ref().is_some_and(|session| {
            session.id == id && session.cleanup_complete.load(Ordering::Acquire)
        }) {
            active.take();
            return true;
        }
        false
    }
    fn get(&self, id: uuid::Uuid) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| INACTIVE.to_string())
    }
}

struct Session {
    id: uuid::Uuid,
    requests: Mutex<Requests>,
    status: Mutex<ScrollStatus>,
    panel_geometry: PanelGeometry,
    window_labels: Vec<String>,
    closing: AtomicBool,
    cleanup_complete: AtomicBool,
}

/// Fixed geometry of the source display, in global logical coordinates.
/// Panel movement must not depend on the mutable capture-state lock.
#[derive(Clone, Copy)]
struct PanelGeometry {
    screen: Rect,
    selection: Rect,
    width: f64,
    height: f64,
    backing_scale: f64,
}

#[derive(Default)]
struct Requests {
    cancelled: bool,
    saving: bool,
    // Remains owned while a request is local to the worker during native
    // stop/drain, before the final persistence gate is entered.
    finishing: bool,
    finish: Option<FinishRequest>,
}
struct FinishRequest {
    since: Instant,
    allow_partial: bool,
    reply: mpsc::Sender<Result<(), String>>,
}
impl Requests {
    fn cancel(&mut self) -> Result<(), String> {
        if self.saving {
            return Err("Scrolling capture is already saving.".into());
        }
        self.cancelled = true;
        self.finishing = false;
        if let Some(request) = self.finish.take() {
            let _ = request.reply.send(Err(INACTIVE.into()));
        }
        Ok(())
    }
    fn finish(&mut self, request: FinishRequest) -> Result<(), String> {
        if self.cancelled {
            return Err(INACTIVE.into());
        }
        if self.saving || self.finishing {
            return Err("Scrolling capture is already finishing.".into());
        }
        self.finishing = true;
        self.finish = Some(request);
        Ok(())
    }

    fn finish_failed(&mut self) {
        self.finishing = false;
        self.saving = false;
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollStatus {
    session_id: uuid::Uuid,
    phase: &'static str,
    width: u32,
    height: u32,
    revision: u64,
    frames: u64,
    detail_preview: Option<DetailPreview>,
    viewport_top: u32,
    viewport_height: u32,
    content_origin: i64,
    can_save_partial: bool,
    message: Option<&'static str>,
}
/// One atomic native-pixel preview: its image and document coordinates must
/// always move together, even when encoding lags behind the latest viewport.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailPreview {
    image: String,
    revision: u64,
    left: u32,
    top: i64,
    width: u32,
    height: u32,
    display_scale: f64,
}

impl ScrollStatus {
    fn new(id: uuid::Uuid) -> Self {
        Self {
            session_id: id,
            phase: "starting",
            width: 0,
            height: 0,
            revision: 0,
            frames: 0,
            detail_preview: None,
            viewport_top: 0,
            viewport_height: 0,
            content_origin: 0,
            can_save_partial: false,
            message: None,
        }
    }
}

pub(crate) fn supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        !crate::capture::linux::is_wayland()
    }
    #[cfg(not(target_os = "linux"))]
    {
        cfg!(any(target_os = "macos", windows))
    }
}
fn session_windows_gone(app: &AppHandle, session: &Session) -> bool {
    session
        .window_labels
        .iter()
        .all(|label| app.get_webview_window(label).is_none())
}

fn active_session(app: &AppHandle) -> Option<Arc<Session>> {
    let state = app.state::<AppState>();
    let session = state.scroll_capture.0.lock().unwrap().clone()?;
    // A teardown that exceeded its bounded wait can finish later. Reconcile
    // the native registry before the next action without leaving a stuck gate.
    if session.cleanup_complete.load(Ordering::Acquire)
        && state
            .scroll_capture
            .release_closed(session.id, session_windows_gone(app, &session))
    {
        return None;
    }
    Some(session)
}

pub(crate) fn ensure_idle(app: &AppHandle) -> Result<(), String> {
    if active_session(app).is_some() {
        Err("Finish the current scrolling capture first.".into())
    } else {
        Ok(())
    }
}
pub(crate) fn show_if_active(app: &AppHandle) -> bool {
    let Some(session) = active_session(app) else {
        return false;
    };
    // A repeated shortcut must not reshow a mask that is being torn down.
    if session.closing.load(Ordering::Acquire) {
        return true;
    }
    platform::show_window_without_activation(app, REGION, TransientWindowRole::ScrollCaptureRegion);
    platform::show_window_without_activation(app, PANEL, TransientWindowRole::RecordingControls);
    true
}

pub(crate) fn handle_escape(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) -> bool {
    if *shortcut != Shortcut::new(None, Code::Escape) {
        return false;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let active = state.scroll_capture.0.lock().unwrap().clone();
    let Some(session) = active else {
        return false;
    };
    if event == ShortcutState::Pressed {
        let _ = session.requests.lock().unwrap().cancel();
    }
    true
}
fn watch_session_window(window: &WebviewWindow, session_id: uuid::Uuid) {
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(state) = app.try_state::<AppState>() {
                state.scroll_capture.cancel_owned(session_id);
            }
        }
    });
}

fn owner(window: &WebviewWindow, app: &AppHandle, id: uuid::Uuid) -> Result<Arc<Session>, String> {
    if window.label() != PANEL {
        return Err("This command is unavailable from this window.".into());
    }
    // A delayed command from an older panel must not operate on its replacement.
    let url = window.url().map_err(|_| INACTIVE.to_string())?;
    if !url
        .query_pairs()
        .any(|(key, value)| key == "sessionId" && value == id.to_string())
    {
        return Err(INACTIVE.into());
    }
    app.state::<AppState>().scroll_capture.get(id)
}
#[tauri::command]
pub fn scroll_capture_status(
    window: WebviewWindow,
    app: AppHandle,
    session_id: uuid::Uuid,
) -> Result<ScrollStatus, String> {
    let session = owner(&window, &app, session_id)?;
    let result = session.status.lock().unwrap().clone();
    Ok(result)
}
/// Physical coordinates submitted to the native window after clamping.
/// Native position writes can apply after the command returns; only the
/// WindowEvent::Moved callback reports the window's observed position.
#[derive(Clone, Copy, Serialize)]
pub struct ScrollPanelPosition {
    x: i32,
    y: i32,
}

#[tauri::command]
pub fn move_scroll_capture_panel(
    window: WebviewWindow,
    app: AppHandle,
    session_id: uuid::Uuid,
    x: f64,
    y: f64,
) -> Result<ScrollPanelPosition, String> {
    let session = owner(&window, &app, session_id)?;
    {
        let requests = session.requests.lock().unwrap();
        if requests.cancelled || requests.saving {
            return Err(INACTIVE.into());
        }
    }
    let geometry = session.panel_geometry;
    let (x, y) = panel_position(geometry, x, y, cfg!(any(target_os = "macos", windows)))
        .ok_or_else(|| {
            "The scrolling capture panel cannot be moved to that position.".to_string()
        })?;
    // No session/capture mutex is held across a native window write. The owned
    // window handle cannot target a replacement session after this one closes.
    #[cfg(target_os = "macos")]
    let position = tauri::LogicalPosition::new(
        f64::from(x) / geometry.backing_scale,
        f64::from(y) / geometry.backing_scale,
    );
    #[cfg(not(target_os = "macos"))]
    let position = tauri::PhysicalPosition::new(x, y);
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    Ok(ScrollPanelPosition { x, y })
}

#[tauri::command]
pub fn cancel_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    session_id: uuid::Uuid,
) -> Result<(), String> {
    owner(&window, &app, session_id)?
        .requests
        .lock()
        .unwrap()
        .cancel()
}
#[tauri::command]
pub async fn finish_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    session_id: uuid::Uuid,
    allow_partial: bool,
) -> Result<(), String> {
    finish_session(owner(&window, &app, session_id)?, allow_partial).await
}

/// Local CLI controls bind the currently active session before scheduling work.
/// They share the panel's request state machine and cannot save a partial image.
pub(crate) fn cancel_active(app: &AppHandle) -> Result<(), String> {
    let session = active_control_session(app)?;
    let result = session.requests.lock().unwrap().cancel();
    result
}

pub(crate) fn finish_active(
    app: AppHandle,
) -> impl std::future::Future<Output = Result<(), String>> + Send + 'static {
    let session = active_control_session(&app);
    async move { finish_session(session?, false).await }
}

fn active_control_session(app: &AppHandle) -> Result<Arc<Session>, String> {
    active_session(app)
        .filter(|session| !session.closing.load(Ordering::Acquire))
        .ok_or_else(|| INACTIVE.to_string())
}

async fn finish_session(session: Arc<Session>, allow_partial: bool) -> Result<(), String> {
    if session.closing.load(Ordering::Acquire) {
        return Err(INACTIVE.into());
    }
    let (reply, receive) = mpsc::channel();
    session.requests.lock().unwrap().finish(FinishRequest {
        since: Instant::now(),
        allow_partial,
        reply,
    })?;
    session.status.lock().unwrap().phase = "finishing";
    // The capture worker acknowledges the final-frame check and save. No UI
    // event loop is blocked while native capture delivers its final frames.
    tauri::async_runtime::spawn_blocking(move || {
        receive.recv().unwrap_or_else(|_| Err(INACTIVE.into()))
    })
    .await
    .map_err(|_| INACTIVE.to_string())?
}

#[tauri::command]
pub async fn start_scroll_capture(
    window: WebviewWindow,
    app: AppHandle,
    capture_id: uuid::Uuid,
    selection: RectDto,
) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        start(
            app,
            label,
            capture_id,
            Rect::new(selection.x, selection.y, selection.width, selection.height),
        )
    })
    .await
    .map_err(|error| format!("Could not start scrolling capture: {error}"))?
}

fn start(app: AppHandle, label: String, id: uuid::Uuid, selection: Rect) -> Result<(), String> {
    if !supported() {
        return Err("Scrolling capture is unavailable in this desktop session.".into());
    }
    let (capture, frame, compact, control) = {
        let state = app.state::<AppState>();
        let _transition = state.library_transition.lock().unwrap();
        let mut active = state.scroll_capture.0.lock().unwrap();
        if active.is_some() {
            return Err("Finish the current scrolling capture first.".into());
        }
        let mut flow = state.capture.lock().unwrap();
        let session = flow
            .session
            .as_ref()
            .ok_or_else(|| "No active capture session.".to_string())?;
        if session.capture_id != id || !session.overlay_labels.contains(&label) {
            return Err("Capture command is only available to its overlay.".into());
        }
        if session.annotation.is_some() {
            return Err("Start scrolling capture before adding annotations.".into());
        }
        let pixels =
            scroll::pixel_region(&session.display, selection).map_err(|error| error.to_string())?;
        ScrollDocument::new(pixels.width, pixels.height).map_err(|error| error.to_string())?;
        let (frame, compact) = panel_frame(
            session.display.screen_frame,
            selection,
            cfg!(any(target_os = "macos", windows)),
        )
        .ok_or_else(|| {
            "Leave room outside the selection for scrolling capture controls.".to_string()
        })?;
        let screen = session.display.screen_frame;
        let session_id = uuid::Uuid::new_v4();
        let control = Arc::new(Session {
            id: session_id,
            requests: Mutex::new(Requests::default()),
            status: Mutex::new(ScrollStatus::new(session_id)),
            window_labels: session
                .overlay_labels
                .iter()
                .cloned()
                .chain([PANEL.to_string(), REGION.to_string()])
                .collect(),
            closing: AtomicBool::new(false),
            cleanup_complete: AtomicBool::new(false),
            panel_geometry: PanelGeometry {
                screen,
                selection: Rect::new(
                    screen.x + selection.x,
                    screen.y + selection.y,
                    selection.width,
                    selection.height,
                ),
                width: frame.width,
                height: frame.height,
                backing_scale: session.display.backing_scale,
            },
        });
        let capture = flow.session.take().unwrap();
        *active = Some(Arc::clone(&control));
        (capture, frame, compact, control)
    };
    crate::microphone::stop();
    crate::commands::invalidate_capture_resources(&app, &capture);
    let mut owns_escape = false;
    let setup = (|| {
        if control.requests.lock().unwrap().cancelled {
            return Err(INACTIVE.into());
        }
        let shortcut = Shortcut::new(None, Code::Escape);
        if !app.global_shortcut().is_registered(shortcut) {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|_| "Could not register Escape for scrolling capture.".to_string())?;
            owns_escape = true;
        }
        // Resolve while the frozen overlay still holds the original stacking
        // order. Closing it or activating the pre-capture app can raise a
        // different, overlapping window before the source is bound.
        let target = scroll::resolve_target(&capture.display, selection)
            .map_err(|error| error.to_string())?;
        if control.requests.lock().unwrap().cancelled {
            return Err(INACTIVE.into());
        }
        let labels = capture.overlay_labels.clone();
        let source_pid = match target {
            scroll::ScrollTarget::Window { owner_pid, .. } => u32::try_from(owner_pid).ok(),
            scroll::ScrollTarget::Display => capture.return_pid,
        };
        let session_id = control.id;
        let scale = capture.display.backing_scale;
        let screen = capture.display.screen_frame;
        ui(&app, move |app| {
            for label in labels {
                if let Some(window) = app.get_webview_window(&label) {
                    window.hide().map_err(|error| error.to_string())?;
                    window.close().map_err(|error| error.to_string())?;
                }
            }
            // A live, passive hole retains the selected area's position while
            // every wheel, gesture and click goes directly to the source app.
            // Create it before the panel so controls stay above the dimming.
            let region = WebviewWindowBuilder::new(
                &app,
                REGION,
                WebviewUrl::App(
                    format!(
                        "index.html?window=scroll-capture-region&x={}&y={}&width={}&height={}",
                        selection.x, selection.y, selection.width, selection.height
                    )
                    .into(),
                ),
            )
            .title("kiri")
            .inner_size(screen.width, screen.height)
            .position(screen.x, screen.y)
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .build()
            .map_err(|error| error.to_string())?;
            watch_session_window(&region, session_id);
            platform::place_transient_window(&region, screen, scale)
                .map_err(|error| error.to_string())?;
            region
                .set_ignore_cursor_events(true)
                .map_err(|error| error.to_string())?;
            #[cfg(windows)]
            {
                platform::windows::require_window_capture_exclusion(&region)
                    .map_err(|error| error.to_string())?;
                platform::windows::pin_webview_to_display_scale(&region, scale);
            }
            #[cfg(not(windows))]
            platform::set_window_capture_excluded(&app, REGION, true);
            platform::show_window_without_activation(
                &app,
                REGION,
                TransientWindowRole::ScrollCaptureRegion,
            );
            let panel = WebviewWindowBuilder::new(
                &app,
                PANEL,
                WebviewUrl::App(
                    format!(
                        "index.html?window=scroll-capture&sessionId={session_id}&compact={}",
                        u8::from(compact)
                    )
                    .into(),
                ),
            )
            .title("kiri")
            .inner_size(frame.width, frame.height)
            .position(frame.x, frame.y)
            .visible(false)
            .focused(false)
            .focusable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .build()
            .map_err(|error| error.to_string())?;
            watch_session_window(&panel, session_id);
            platform::place_transient_window(&panel, frame, scale)
                .map_err(|error| error.to_string())?;
            #[cfg(windows)]
            platform::windows::require_window_capture_exclusion(&panel)
                .map_err(|error| error.to_string())?;
            #[cfg(not(windows))]
            platform::set_window_capture_excluded(&app, PANEL, true);
            platform::show_window_without_activation(
                &app,
                PANEL,
                TransientWindowRole::RecordingControls,
            );
            if let Some(pid) = source_pid {
                platform::activate_application(pid);
            }
            Ok(())
        })?;
        // Let the source repaint after the frozen overlay has gone. This is a
        // one-time startup wait on this worker, never a per-scroll input delay.
        if control.requests.lock().unwrap().cancelled {
            return Err(INACTIVE.into());
        }
        std::thread::sleep(Duration::from_millis(120));
        if control.requests.lock().unwrap().cancelled {
            return Err(INACTIVE.into());
        }
        scroll::start(&capture.display, selection, &target)
            .map_err(|error| error.to_string())
    })();
    let source = match setup {
        Ok(source) => source,
        Err(error) => {
            cleanup(&app, &control, &capture, owns_escape, None);
            if !control.requests.lock().unwrap().cancelled {
                crate::state::emit_notice(
                    &app,
                    if error
                        .contains("Select a scrolling area fully inside one application window.")
                    {
                        "Select a scrolling area fully inside one application window.".into()
                    } else {
                        "Could not start scrolling capture.".into()
                    },
                    "exclamationmark.triangle".into(),
                );
            }
            log::warn!("[scroll] startup failed: {error}");
            return Err(error);
        }
    };
    // Transfer ownership only after all fallible setup has completed. Keeping
    // the session in this closure ensures native streams stop on every exit.
    let worker_app = app.clone();
    let worker_control = Arc::clone(&control);
    // Spawn through Tauri's blocking pool; unlike a fallible thread spawn it
    // cannot strand the captured origin after ownership has moved.
    std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
        let mut source = source;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(
                &worker_app,
                &worker_control,
                &capture,
                selection,
                &mut source,
            )
        }));
        if let Err(error) = source.stop() {
            log::warn!("[scroll] stop failed: {error:#}");
        }
        let preview = match result {
            Ok(preview) => preview,
            Err(_) => {
                log::error!("[scroll] worker panicked");
                None
            }
        };
        cleanup(&worker_app, &worker_control, &capture, owns_escape, preview);
    }));
    Ok(())
}

struct Stitcher {
    document: ScrollDocument,
    connected: bool,
    limited: bool,
    revision: u64,
    last_motion: Instant,
    last_sequence: u64,
    last_captured_at: Option<Instant>,
    dropped: u64,
    detail_follows_top: bool,
}
impl Stitcher {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        Ok(Self {
            document: ScrollDocument::new(width, height).map_err(|e| e.to_string())?,
            connected: false,
            limited: false,
            revision: 0,
            last_motion: Instant::now(),
            last_sequence: 0,
            last_captured_at: None,
            dropped: 0,
            detail_follows_top: true,
        })
    }
    fn accept(&mut self, frame: ScrollFrame, session: &Session) -> Result<(), String> {
        if frame.sequence <= self.last_sequence
            || self
                .last_captured_at
                .is_some_and(|time| frame.captured_at < time)
        {
            return Err("Scrolling capture frames arrived out of order.".into());
        }
        self.last_sequence = frame.sequence;
        self.last_captured_at = Some(frame.captured_at);
        if frame.dropped_frames != self.dropped {
            log::debug!(
                "[scroll] queue drops={} frame_age_ms={}",
                frame.dropped_frames,
                frame.captured_at.elapsed().as_millis()
            );
            self.dropped = frame.dropped_frames;
        }
        let previous_viewport_top = self.document.origin() + i64::from(self.document.viewport().0);
        let update = self
            .document
            .push(rgba(frame)?)
            .map_err(|e| e.to_string())?;
        if update != ScrollUpdate::Unchanged {
            self.last_motion = Instant::now();
        }
        let was_connected = self.connected;
        self.connected = !matches!(update, ScrollUpdate::Unmatched | ScrollUpdate::LimitReached)
            && !self.document.has_unresolved_patches();
        self.limited = update == ScrollUpdate::LimitReached;
        // Only accepted pixels move the detail crop. An unmatched incoming
        // view must never replace the last confirmed region in the preview.
        match update {
            ScrollUpdate::Extended { top, bottom } if top > 0 || bottom > 0 => {
                self.detail_follows_top = top > 0;
            }
            ScrollUpdate::Located | ScrollUpdate::Reframed => {
                let next_top = self.document.origin() + i64::from(self.document.viewport().0);
                if next_top != previous_viewport_top {
                    self.detail_follows_top = next_top < previous_viewport_top;
                }
            }
            _ => {}
        }
        let mut status = session.status.lock().unwrap();
        // Body reframing can remove fixed viewport edges from either end;
        // the document owns its signed origin, not accumulated UI deltas.
        status.content_origin = self.document.origin();
        if matches!(
            update,
            ScrollUpdate::Started | ScrollUpdate::Extended { .. } | ScrollUpdate::Reframed
        ) {
            self.revision += 1;
        }
        (status.width, status.height) = self.document.dimensions();
        (status.viewport_top, status.viewport_height) = self.document.viewport();
        status.frames = self.document.frame_count();
        status.revision = self.revision;
        if matches!(
            update,
            ScrollUpdate::Started | ScrollUpdate::Extended { .. } | ScrollUpdate::Reframed
        ) || was_connected != self.connected
        {
            log::debug!(
                "[scroll] update={update:?} connected={} size={}x{} origin={} viewport={}+{}",
                self.connected,
                status.width,
                status.height,
                status.content_origin,
                status.viewport_top,
                status.viewport_height
            );
        }
        if status.phase != "finishing" {
            self.set_phase(&mut status);
        }
        Ok(())
    }
    fn set_phase(&self, status: &mut ScrollStatus) {
        status.phase = if self.limited {
            "limit"
        } else if self.connected {
            "capturing"
        } else if self.document.frame_count() == 0 {
            "starting"
        } else {
            "reconnecting"
        };
        status.message = None;
        status.can_save_partial =
            self.document.frame_count() > 0 && (!self.connected || self.limited);
    }
    fn first_frame_timed_out(&self, elapsed: Duration) -> bool {
        self.last_sequence == 0 && elapsed > Duration::from_secs(8)
    }

    fn reset_source_sequence(&mut self) {
        self.last_sequence = 0;
        self.last_captured_at = None;
        self.dropped = 0;
    }
}

fn run(
    app: &AppHandle,
    session: &Arc<Session>,
    capture: &CaptureSession,
    selection: Rect,
    source: &mut ScrollSource,
) -> Option<CompletionPreviewDto> {
    let mut stitcher = Stitcher::new(source.width, source.height).ok()?;
    let preview = preview_worker(Arc::clone(session));
    let mut last_preview = Instant::now() - Duration::from_secs(1);
    let mut detail_key = None;
    let mut source_started = Instant::now();
    let mut frozen = false;
    let mut source_failed = false;
    loop {
        if session.requests.lock().unwrap().cancelled {
            return None;
        }
        let mut queue_empty = frozen;
        if !frozen {
            // Drain in chronological batches, retaining all bridge frames. A
            // finishing request may proceed only after the backlog is empty.
            let first = source.receiver.recv_timeout(Duration::from_millis(25));
            match first {
                Ok(frame) => {
                    if let Err(error) = stitcher.accept(frame, session) {
                        log::warn!("[scroll] {error}");
                        source_failed = true;
                    }
                    // Bound each batch by elapsed work as well as count. A
                    // difficult text frame must not starve Cancel/status/Done
                    // behind a backlog while native scrolling continues.
                    let batch_started = Instant::now();
                    for _ in 0..8 {
                        if batch_started.elapsed() >= Duration::from_millis(40)
                            || session.requests.lock().unwrap().cancelled
                        {
                            break;
                        }
                        match source.receiver.try_recv() {
                            Ok(frame) => {
                                if let Err(error) = stitcher.accept(frame, session) {
                                    log::warn!("[scroll] {error}");
                                    source_failed = true;
                                    break;
                                }
                            }
                            Err(mpsc::TryRecvError::Empty) => {
                                queue_empty = true;
                                break;
                            }
                            Err(mpsc::TryRecvError::Disconnected) => {
                                source_failed = true;
                                break;
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    queue_empty = true;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    source_failed = true;
                }
            }
            if let Some(error) = source.unexpected_failure() {
                log::warn!("[scroll] source failed: {error}");
                source_failed = true;
            }
            if stitcher.first_frame_timed_out(source_started.elapsed()) {
                log::warn!("[scroll] no complete first frame");
                source_failed = true;
            }
            if source_failed {
                let _ = source.stop();
                frozen = true;
                queue_empty = true;
                let mut status = session.status.lock().unwrap();
                status.phase = "failed";
                status.message = Some(SOURCE_FAILED);
                status.can_save_partial = stitcher.document.frame_count() > 0;
            }
        } else {
            std::thread::sleep(Duration::from_millis(25));
        }
        let origin = session.status.lock().unwrap().content_origin;
        let region = detail_region(
            stitcher.document.dimensions(),
            stitcher.document.viewport(),
            stitcher.detail_follows_top,
        );
        let next_detail_key = region.map(|region| (stitcher.revision, origin, region));
        if next_detail_key != detail_key && last_preview.elapsed() >= Duration::from_millis(200) {
            if let Some(sender) = preview.as_ref() {
                let submitted = sender.try_submit(|| {
                    region.and_then(|region| {
                        stitcher
                            .document
                            .preview_region(0, region.top, region.width, region.height)
                            .map(|image| DetailFrame {
                                revision: stitcher.revision,
                                left: 0,
                                top: origin + i64::from(region.top),
                                display_scale: capture.display.backing_scale,
                                image,
                            })
                    })
                });
                if submitted {
                    detail_key = next_detail_key;
                }
            }
            last_preview = Instant::now();
        }
        let request = {
            let mut requests = session.requests.lock().unwrap();
            let ready = requests.finish.as_ref().is_some_and(|request| {
                request.since.elapsed() >= Duration::from_millis(150)
                    && queue_empty
                    && (frozen
                        || request.allow_partial
                        || !stitcher.connected
                        || stitcher.limited
                        || stitcher.last_motion.elapsed() >= Duration::from_millis(100)
                        || request.since.elapsed() >= Duration::from_millis(1500))
            });
            if ready {
                requests.finish.take()
            } else {
                None
            }
        };
        let Some(request) = request else {
            continue;
        };
        if !frozen
            && !request.allow_partial
            && stitcher.connected
            && stitcher.last_motion.elapsed() < Duration::from_millis(100)
        {
            stitcher.set_phase(&mut session.status.lock().unwrap());
            session.requests.lock().unwrap().finish_failed();
            let _ = request
                .reply
                .send(Err("Stop scrolling briefly, then choose Done.".into()));
            continue;
        }
        if !frozen {
            // Stop closes native production, then drain the final completed
            // callbacks. This includes frames queued after the Done click.
            let stopped = match source.stop() {
                Ok(()) => true,
                Err(error) => {
                    log::warn!("[scroll] final stop failed: {error:#}");
                    source_failed = true;
                    false
                }
            };
            frozen = true;
            // A timed-out native shutdown can still own a live producer. Its
            // uncertain tail must not extend the document or keep this loop
            // draining indefinitely; retain the already verified partial area.
            if stopped {
                while let Ok(frame) = source.receiver.try_recv() {
                    if let Err(error) = stitcher.accept(frame, session) {
                        log::warn!("[scroll] final frame failed: {error}");
                        source_failed = true;
                    }
                }
            }
            if source.unexpected_failure().is_some() {
                source_failed = true;
            }
        }
        if session.requests.lock().unwrap().cancelled {
            let _ = request.reply.send(Err(INACTIVE.into()));
            return None;
        }
        if !request.allow_partial && (source_failed || !stitcher.connected || stitcher.limited) {
            // Keep the document and reopen live sampling so the user can
            // naturally return through an unmatched area and continue.
            if !source_failed {
                match scroll::start(&capture.display, selection, &source.target) {
                    Ok(next) => {
                        *source = next;
                        frozen = false;
                        source_started = Instant::now();
                        stitcher.reset_source_sequence();
                    }
                    Err(error) => {
                        log::warn!("[scroll] resume failed: {error:#}");
                        source_failed = true;
                    }
                }
            }
            let mut status = session.status.lock().unwrap();
            stitcher.set_phase(&mut status);
            if source_failed {
                status.phase = "failed";
                status.message = Some(SOURCE_FAILED);
                status.can_save_partial = stitcher.document.frame_count() > 0;
            }
            drop(status);
            session.requests.lock().unwrap().finish_failed();
            let _ = request.reply.send(Err(RECONNECT.into()));
            continue;
        }
        let Some(image) = stitcher.document.image() else {
            let mut status = session.status.lock().unwrap();
            status.phase = "failed";
            status.message = Some(SOURCE_FAILED);
            drop(status);
            session.requests.lock().unwrap().finish_failed();
            let _ = request
                .reply
                .send(Err("No scrolling content has been captured yet.".into()));
            continue;
        };
        {
            let mut requests = session.requests.lock().unwrap();
            if requests.cancelled {
                let _ = request.reply.send(Err(INACTIVE.into()));
                return None;
            }
            requests.saving = true;
        }
        session.status.lock().unwrap().phase = "saving";
        let size = image.dimensions();
        let result = encode(image)
            .and_then(|png| crate::commands::save_scroll_capture(app, capture, &png, size));
        match result {
            Ok(preview) => {
                let _ = request.reply.send(Ok(()));
                return Some(preview);
            }
            Err(error) => {
                log::warn!("[scroll] save failed: {error}");
                session.requests.lock().unwrap().finish_failed();
                let mut status = session.status.lock().unwrap();
                status.phase = "failed";
                status.message = Some(SAVE_FAILED);
                status.can_save_partial = source_failed || !stitcher.connected || stitcher.limited;
                // Sampling stays stopped. Retrying writes this exact document;
                // fresh frames cannot erase the error or change the result.
                let _ = request.reply.send(Err(SAVE_FAILED.into()));
            }
        }
    }
}

fn rgba(frame: ScrollFrame) -> Result<RgbaImage, String> {
    let row = frame.width as usize * 4;
    if frame.stride < row || frame.pixels.len() < frame.stride.saturating_mul(frame.height as usize)
    {
        return Err("The scrolling capture frame is incomplete.".into());
    }
    let mut image = RgbaImage::new(frame.width, frame.height);
    for (source, target) in frame
        .pixels
        .chunks_exact(frame.stride)
        .take(frame.height as usize)
        .zip(image.as_mut().chunks_exact_mut(row))
    {
        for (bgra, rgba) in source
            .chunks_exact(4)
            .take(frame.width as usize)
            .zip(target.chunks_exact_mut(4))
        {
            rgba.copy_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
        }
    }
    Ok(image)
}
fn encode(image: RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(bytes.into_inner())
}
const MAX_DETAIL_HEIGHT: u32 = 1536;
const MAX_DETAIL_PIXELS: u32 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DetailRegion {
    top: u32,
    width: u32,
    height: u32,
}

fn detail_region(
    (width, document_height): (u32, u32),
    (viewport_top, viewport_height): (u32, u32),
    follows_top: bool,
) -> Option<DetailRegion> {
    if width == 0 || document_height == 0 || viewport_height == 0 {
        return None;
    }
    let height = MAX_DETAIL_HEIGHT
        .min(MAX_DETAIL_PIXELS / width)
        .min(document_height);
    if height == 0 {
        return None;
    }
    let top = if follows_top {
        viewport_top
    } else {
        viewport_top
            .saturating_add(viewport_height)
            .saturating_sub(height)
    }
    .min(document_height - height);
    Some(DetailRegion { top, width, height })
}

struct DetailFrame {
    revision: u64,
    left: u32,
    top: i64,
    display_scale: f64,
    image: RgbaImage,
}
fn encode_preview(image: RgbaImage) -> Option<String> {
    encode(image).ok().map(|bytes| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    })
}

fn encode_detail(frame: DetailFrame) -> Option<DetailPreview> {
    let (width, height) = frame.image.dimensions();
    Some(DetailPreview {
        image: encode_preview(frame.image)?,
        revision: frame.revision,
        left: frame.left,
        top: frame.top,
        width,
        height,
        display_scale: frame.display_scale,
    })
}

fn publish_preview(status: &mut ScrollStatus, detail: Option<DetailPreview>) {
    if let Some(frame) = detail.filter(|frame| {
        status
            .detail_preview
            .as_ref()
            .is_none_or(|current| frame.revision >= current.revision)
    }) {
        // Revisited viewports can share a revision. The single FIFO worker
        // preserves their order while publishing all coordinates atomically.
        status.detail_preview = Some(frame);
    }
}

struct PreviewSender {
    sender: mpsc::SyncSender<DetailFrame>,
    available: Arc<AtomicBool>,
}
impl PreviewSender {
    fn try_submit(&self, build: impl FnOnce() -> Option<DetailFrame>) -> bool {
        // Reserve the encoder before copying preview pixels. A slow PNG encode
        // must not make the stitching thread repeatedly build discarded previews.
        if self
            .available
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        if build().is_some_and(|frame| self.sender.try_send(frame).is_ok()) {
            true
        } else {
            self.available.store(true, Ordering::Release);
            false
        }
    }
}

fn preview_worker(session: Arc<Session>) -> Option<PreviewSender> {
    // One reserved job, including the running encoder. The visible native
    // region has a fixed pixel budget and never clones the entire long image.
    let (sender, receiver) = mpsc::sync_channel::<DetailFrame>(1);
    let available = Arc::new(AtomicBool::new(true));
    let worker_available = Arc::clone(&available);
    std::thread::Builder::new()
        .name("kiri-scroll-preview".into())
        .spawn(move || {
            for frame in receiver {
                let detail = encode_detail(frame);
                publish_preview(&mut session.status.lock().unwrap(), detail);
                worker_available.store(true, Ordering::Release);
            }
        })
        .ok()
        .map(|_| PreviewSender { sender, available })
}

// The native event loop must stay free to process Close/Destroyed. This runs
// only on the capture worker, holds no session lock, and has a fixed deadline.
fn wait_for_window_removal(mut gone: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if gone() {
            return true;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

fn cleanup(
    app: &AppHandle,
    session: &Session,
    capture: &CaptureSession,
    owns_escape: bool,
    preview: Option<CompletionPreviewDto>,
) {
    session.closing.store(true, Ordering::Release);
    if owns_escape {
        let _ = app
            .global_shortcut()
            .unregister(Shortcut::new(None, Code::Escape));
    }
    let labels = session.window_labels.clone();
    let monitor = ui(app, move |app| {
        let monitor = app
            .get_webview_window(PANEL)
            .and_then(|window| window.current_monitor().ok().flatten());
        for label in labels {
            if let Some(window) = app.get_webview_window(&label) {
                // Hide first: close() only enqueues a native request, even on
                // the main thread. Neither the mask nor the controls should
                // remain visible while that request is pending.
                #[cfg(windows)]
                let hidden = platform::windows::hide_window_for_capture(&window)
                    .map_err(|error| error.to_string());
                #[cfg(not(windows))]
                let hidden = window.hide().map_err(|error| error.to_string());
                if let Err(error) = hidden {
                    log::warn!("[scroll] could not hide {label}: {error}");
                }
                if let Err(error) = window.close() {
                    log::warn!("[scroll] could not close {label}: {error}");
                }
            }
        }
        Ok(monitor)
    })
    .ok()
    .flatten();
    if !wait_for_window_removal(
        || session_windows_gone(app, session),
        Duration::from_secs(2),
    ) {
        // A close listener can prevent CloseRequested. Force owned windows to
        // close once, then stop waiting; never spin or block the event loop.
        for label in &session.window_labels {
            if let Some(window) = app.get_webview_window(label) {
                if let Err(error) = window.destroy() {
                    log::warn!("[scroll] could not destroy {label}: {error}");
                }
            }
        }
        if !wait_for_window_removal(
            || session_windows_gone(app, session),
            Duration::from_secs(1),
        ) {
            log::warn!("[scroll] native window teardown is still pending");
        }
    }
    let hidden = capture.hidden_windows.clone();
    let was_front = capture.was_kiri_frontmost;
    let pid = capture.return_pid;
    let _ = ui(app, move |app| {
        crate::commands::restore_capture_origin(&app, &hidden, was_front, pid);
        if let Some(preview) = preview {
            crate::state::show_completion_preview(&app, &preview, monitor);
        }
        Ok(())
    });
    // Release only after both native deregistration and origin restoration.
    // If native teardown timed out, the next action reconciles this guard.
    session.cleanup_complete.store(true, Ordering::Release);
    app.state::<AppState>()
        .scroll_capture
        .release_closed(session.id, session_windows_gone(app, session));
}

// WebView2 construction belongs off the Windows event loop. AppKit/GTK window
// creation belongs on it; callers of this helper are always background workers.
fn ui<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    #[cfg(windows)]
    {
        task(app.clone())
    }
    #[cfg(not(windows))]
    {
        let (sender, receiver) = mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(task(handle));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .map_err(|_| "The window event loop stopped.".to_string())?
    }
}

/// Clamp before moving: X11 has no window exclusion, so even an intermediate
/// native position must keep the entire panel outside the selected content.
/// Work in whole physical pixels and round bounds inward to retain the gap at
/// fractional DPI, including displays with negative desktop coordinates.
fn panel_position(
    geometry: PanelGeometry,
    x: f64,
    y: f64,
    allow_inside: bool,
) -> Option<(i32, i32)> {
    let PanelGeometry {
        screen,
        selection,
        width,
        height,
        backing_scale: scale,
    } = geometry;
    if ![
        x,
        y,
        screen.x,
        screen.y,
        screen.width,
        screen.height,
        selection.x,
        selection.y,
        selection.width,
        selection.height,
        width,
        height,
        scale,
    ]
    .into_iter()
    .all(f64::is_finite)
        || scale <= 0.0
        || width <= 0.0
        || height <= 0.0
        || screen.width < width
        || screen.height < height
        || selection.width <= 0.0
        || selection.height <= 0.0
        || selection.x < screen.x
        || selection.y < screen.y
        || selection.x + selection.width > screen.x + screen.width
        || selection.y + selection.height > screen.y + screen.height
    {
        return None;
    }
    // ceil is deliberately conservative if the native size rounded a
    // fractional logical dimension upward when the window was created.
    let panel_width = (width * scale).ceil();
    let panel_height = (height * scale).ceil();
    let min_x = (screen.x * scale).ceil();
    let min_y = (screen.y * scale).ceil();
    let max_x = ((screen.x + screen.width) * scale).floor() - panel_width;
    let max_y = ((screen.y + screen.height) * scale).floor() - panel_height;
    if ![min_x, min_y, max_x, max_y].into_iter().all(f64::is_finite)
        || min_x > max_x
        || min_y > max_y
        || min_x < f64::from(i32::MIN)
        || min_y < f64::from(i32::MIN)
        || max_x > f64::from(i32::MAX)
        || max_y > f64::from(i32::MAX)
    {
        return None;
    }
    let project = |left: f64, top: f64, right: f64, bottom: f64| {
        if left > right || top > bottom {
            return None;
        }
        Some((x.round().clamp(left, right), y.round().clamp(top, bottom)))
    };
    if allow_inside {
        return project(min_x, min_y, max_x, max_y).map(|(x, y)| (x as i32, y as i32));
    }
    const GAP: f64 = 10.0;
    // Legal top-left positions form the union of four closed rectangles.
    // Projecting onto each and choosing the nearest never crosses the capture.
    [
        project(
            min_x,
            min_y,
            max_x.min(((selection.x - GAP) * scale).floor() - panel_width),
            max_y,
        ),
        project(
            min_x.max(((selection.x + selection.width + GAP) * scale).ceil()),
            min_y,
            max_x,
            max_y,
        ),
        project(
            min_x,
            min_y,
            max_x,
            max_y.min(((selection.y - GAP) * scale).floor() - panel_height),
        ),
        project(
            min_x,
            min_y.max(((selection.y + selection.height + GAP) * scale).ceil()),
            max_x,
            max_y,
        ),
    ]
    .into_iter()
    .flatten()
    .min_by(|a, b| {
        (a.0 - x)
            .hypot(a.1 - y)
            .total_cmp(&(b.0 - x).hypot(b.1 - y))
    })
    .map(|(x, y)| (x as i32, y as i32))
}

/// Prefer a preview outside the selected content, then compact controls.
/// Native window exclusion permits an inside fallback; X11 must leave room.
fn panel_frame(screen: Rect, selection: Rect, allow_inside: bool) -> Option<(Rect, bool)> {
    const GAP: f64 = 10.0;
    for (width, height, compact) in [
        (320.0, 400.0, false),
        (280.0, 360.0, false),
        (220.0, 76.0, true),
    ] {
        let candidates = [
            (selection.x + selection.width + GAP, selection.y),
            (selection.x - width - GAP, selection.y),
            (selection.x, selection.y + selection.height + GAP),
            (selection.x, selection.y - height - GAP),
        ];
        for (x, y) in candidates {
            let x = x.clamp(0.0, (screen.width - width).max(0.0));
            let y = y.clamp(0.0, (screen.height - height).max(0.0));
            if width <= screen.width
                && height <= screen.height
                && (x + width + GAP <= selection.x
                    || x >= selection.x + selection.width + GAP
                    || y + height + GAP <= selection.y
                    || y >= selection.y + selection.height + GAP)
            {
                return Some((
                    Rect::new(screen.x + x, screen.y + y, width, height),
                    compact,
                ));
            }
        }
    }
    if allow_inside && screen.width >= 240.0 && screen.height >= 96.0 {
        return Some((
            Rect::new(
                screen.x + screen.width - 230.0,
                screen.y + screen.height - 86.0,
                220.0,
                76.0,
            ),
            true,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_panel_geometry() -> PanelGeometry {
        PanelGeometry {
            screen: Rect::new(0.0, 0.0, 1000.0, 800.0),
            selection: Rect::new(300.0, 200.0, 400.0, 400.0),
            width: 200.0,
            height: 100.0,
            backing_scale: 1.0,
        }
    }

    fn lifecycle_session() -> Arc<Session> {
        let id = uuid::Uuid::new_v4();
        Arc::new(Session {
            id,
            requests: Mutex::new(Requests::default()),
            status: Mutex::new(ScrollStatus::new(id)),
            panel_geometry: test_panel_geometry(),
            window_labels: vec![PANEL.to_string(), REGION.to_string()],
            closing: AtomicBool::new(false),
            cleanup_complete: AtomicBool::new(false),
        })
    }

    #[test]
    fn destroyed_window_cancels_only_its_own_running_session() {
        let session = lifecycle_session();
        let state = ScrollCaptureState(Mutex::new(Some(Arc::clone(&session))));
        state.cancel_owned(uuid::Uuid::new_v4());
        assert!(!session.requests.lock().unwrap().cancelled);
        state.cancel_owned(session.id);
        assert!(session.requests.lock().unwrap().cancelled);
    }

    #[test]
    fn expected_teardown_does_not_reclassify_startup_failure_as_cancellation() {
        let session = lifecycle_session();
        let state = ScrollCaptureState(Mutex::new(Some(Arc::clone(&session))));
        session.closing.store(true, Ordering::Release);
        state.cancel_owned(session.id);
        assert!(!session.requests.lock().unwrap().cancelled);
    }

    #[test]
    fn close_acknowledgement_does_not_release_session_before_native_removal() {
        let session = lifecycle_session();
        let state = ScrollCaptureState(Mutex::new(Some(Arc::clone(&session))));
        session.closing.store(true, Ordering::Release);
        session.cleanup_complete.store(true, Ordering::Release);
        assert!(!state.release_closed(session.id, false));
        assert!(
            state.is_active(),
            "queued close still owns its window labels"
        );
        assert!(state.release_closed(session.id, true));
        assert!(!state.is_active());
    }

    #[test]
    fn native_removal_does_not_release_before_origin_restoration_finishes() {
        let session = lifecycle_session();
        let state = ScrollCaptureState(Mutex::new(Some(Arc::clone(&session))));
        session.closing.store(true, Ordering::Release);
        assert!(!state.release_closed(session.id, true));
        session.cleanup_complete.store(true, Ordering::Release);
        assert!(state.release_closed(session.id, true));
    }

    #[test]
    fn late_destroyed_and_cleanup_cannot_cancel_or_release_replacement_session() {
        let old = lifecycle_session();
        let state = ScrollCaptureState(Mutex::new(Some(Arc::clone(&old))));
        old.closing.store(true, Ordering::Release);
        old.cleanup_complete.store(true, Ordering::Release);
        assert!(state.release_closed(old.id, true));
        let current = lifecycle_session();
        *state.0.lock().unwrap() = Some(Arc::clone(&current));
        state.cancel_owned(old.id);
        assert!(!state.release_closed(old.id, true));
        assert_eq!(state.get(current.id).unwrap().id, current.id);
        assert!(!current.requests.lock().unwrap().cancelled);
    }

    #[test]
    fn native_removal_wait_observes_progress_and_has_a_deadline() {
        let mut observations = 0;
        assert!(wait_for_window_removal(
            || {
                observations += 1;
                observations == 2
            },
            Duration::from_secs(1)
        ));
        assert_eq!(observations, 2);
        assert!(!wait_for_window_removal(|| false, Duration::ZERO));
        assert!(wait_for_window_removal(|| true, Duration::ZERO));
    }

    #[test]
    fn panel_moves_use_physical_pixels_and_clamp_negative_origin_displays() {
        let geometry = PanelGeometry {
            screen: Rect::new(-1600.0, 80.0, 1600.0, 960.0),
            selection: Rect::new(-1500.0, 160.0, 1000.0, 700.0),
            width: 280.0,
            height: 360.0,
            backing_scale: 1.25,
        };
        assert_eq!(
            panel_position(geometry, -1800.25, 111.49, true),
            Some((-1800, 111))
        );
        assert_eq!(
            panel_position(geometry, -9999.0, -9999.0, true),
            Some((-2000, 100))
        );
        assert_eq!(
            panel_position(geometry, 9999.0, 9999.0, true),
            Some((-350, 850))
        );
        let full = PanelGeometry {
            selection: geometry.screen,
            ..geometry
        };
        assert_eq!(
            panel_position(full, -1800.0, 111.0, true),
            Some((-1800, 111))
        );
        assert!(panel_position(full, -1800.0, 111.0, false).is_none());
    }

    #[test]
    fn x11_panel_moves_choose_the_nearest_available_outside_region() {
        let geometry = test_panel_geometry();
        assert_eq!(
            panel_position(geometry, 470.0, 350.0, false),
            Some((710, 350))
        );
        assert_eq!(
            panel_position(geometry, 350.0, 190.0, false),
            Some((350, 90))
        );
        assert_eq!(
            panel_position(geometry, 120.0, 350.0, false),
            Some((90, 350))
        );
        assert_eq!(
            panel_position(geometry, 350.0, 580.0, false),
            Some((350, 610))
        );
        assert_eq!(
            panel_position(geometry, 950.0, 760.0, false),
            Some((800, 700))
        );
        let edge = PanelGeometry {
            selection: Rect::new(0.0, 0.0, 790.0, 800.0),
            ..geometry
        };
        assert_eq!(panel_position(edge, 100.0, 200.0, false), Some((800, 200)));
        let no_room = PanelGeometry {
            selection: Rect::new(0.0, 0.0, 791.0, 800.0),
            ..geometry
        };
        assert!(panel_position(no_room, 100.0, 200.0, false).is_none());
    }

    #[test]
    fn x11_fractional_dpi_rounding_never_reduces_the_capture_gap() {
        let geometry = PanelGeometry {
            screen: Rect::new(-1000.0, -400.0, 1000.0, 800.0),
            selection: Rect::new(-700.3, -200.7, 400.1, 400.2),
            backing_scale: 1.25,
            ..test_panel_geometry()
        };
        for x in (-1500..500).step_by(37) {
            for y in (-800..800).step_by(53) {
                let (x, y) = panel_position(geometry, f64::from(x), f64::from(y), false).unwrap();
                let x = f64::from(x) / geometry.backing_scale;
                let y = f64::from(y) / geometry.backing_scale;
                assert!(x >= geometry.screen.x && y >= geometry.screen.y);
                assert!(x + geometry.width <= geometry.screen.x + geometry.screen.width);
                assert!(y + geometry.height <= geometry.screen.y + geometry.screen.height);
                assert!(
                    x + geometry.width + 10.0 <= geometry.selection.x
                        || x >= geometry.selection.x + geometry.selection.width + 10.0
                        || y + geometry.height + 10.0 <= geometry.selection.y
                        || y >= geometry.selection.y + geometry.selection.height + 10.0
                );
            }
        }
    }

    #[test]
    fn panel_moves_reject_invalid_coordinates_or_unrepresentable_geometry() {
        let geometry = test_panel_geometry();
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(panel_position(geometry, invalid, 100.0, true).is_none());
            assert!(panel_position(geometry, 100.0, invalid, false).is_none());
        }
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MAX] {
            assert!(panel_position(
                PanelGeometry {
                    backing_scale: scale,
                    ..geometry
                },
                0.0,
                0.0,
                true
            )
            .is_none());
        }
        assert!(panel_position(
            PanelGeometry {
                width: 1001.0,
                ..geometry
            },
            0.0,
            0.0,
            true
        )
        .is_none());
        assert!(panel_position(
            PanelGeometry {
                selection: Rect::new(-1.0, 0.0, 10.0, 10.0),
                ..geometry
            },
            0.0,
            0.0,
            true
        )
        .is_none());
    }

    #[test]
    fn controls_stay_outside_capture_including_negative_screen_coordinates() {
        let screen = Rect::new(-1400.0, -200.0, 1400.0, 900.0);
        let (frame, compact) =
            panel_frame(screen, Rect::new(50.0, 30.0, 1040.0, 800.0), false).unwrap();
        assert!(!compact);
        assert_eq!(frame.x, -300.0);
        assert_eq!((frame.width, frame.height), (280.0, 360.0));
        let (wide_frame, compact) =
            panel_frame(screen, Rect::new(50.0, 30.0, 900.0, 800.0), false).unwrap();
        assert!(!compact);
        assert_eq!((wide_frame.width, wide_frame.height), (320.0, 400.0));
        assert!(wide_frame.x >= screen.x + 50.0 + 900.0 + 10.0);
        let (_, compact) =
            panel_frame(screen, Rect::new(0.0, 100.0, 1400.0, 800.0), false).unwrap();
        assert!(compact);
        assert!(panel_frame(screen, Rect::new(0.0, 0.0, 1400.0, 900.0), false).is_none());
    }
    #[test]
    fn full_display_controls_require_exclusion_and_fit_the_display() {
        for screen in [
            Rect::new(-1400.0, -200.0, 1400.0, 900.0),
            Rect::new(1920.0, 300.0, 240.0, 96.0),
        ] {
            let selection = Rect::new(0.0, 0.0, screen.width, screen.height);
            // X11 has no native control exclusion and must fail safely.
            assert!(panel_frame(screen, selection, false).is_none());
            // SCK/WGC may use capture-excluded compact controls inside a
            // full-display selection, including at negative desktop origins.
            let (panel, compact) = panel_frame(screen, selection, true).unwrap();
            assert!(compact);
            assert!(panel.x >= screen.x && panel.y >= screen.y);
            assert!(panel.x + panel.width <= screen.x + screen.width);
            assert!(panel.y + panel.height <= screen.y + screen.height);
        }
    }

    #[test]
    fn detail_crop_keeps_native_width_and_follows_the_accepted_edge_within_budget() {
        assert_eq!(
            detail_region((1180, 8000), (3000, 1280), false),
            Some(DetailRegion {
                top: 2744,
                width: 1180,
                height: 1536
            })
        );
        assert_eq!(
            detail_region((1180, 8000), (3000, 1280), true),
            Some(DetailRegion {
                top: 3000,
                width: 1180,
                height: 1536
            })
        );
        // Very wide physical captures obey the independent 4 Mi-pixel budget.
        let wide = detail_region((8192, 8000), (2000, 1280), false).unwrap();
        assert_eq!(
            wide,
            DetailRegion {
                top: 2768,
                width: 8192,
                height: 512
            }
        );
        assert_eq!(wide.width * wide.height, MAX_DETAIL_PIXELS);
        assert_eq!(
            detail_region((1180, 1280), (0, 1280), false).unwrap().top,
            0
        );
        assert_eq!(
            detail_region((1180, 8000), (7800, 1280), true).unwrap().top,
            6464
        );
        assert!(detail_region((1180, 0), (0, 0), true).is_none());
    }

    #[test]
    fn detail_png_and_coordinates_publish_as_one_snapshot_even_when_encoding_lags() {
        let image = RgbaImage::from_fn(37, 69, |x, y| {
            image::Rgba([x as u8, y as u8, (x + y) as u8, 255])
        });
        let encoded = encode_detail(DetailFrame {
            revision: 5,
            left: 0,
            top: -404,
            display_scale: 2.0,
            image: image.clone(),
        })
        .unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                encoded
                    .image
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().to_rgba8(), image);
        assert_eq!(
            (
                encoded.width,
                encoded.height,
                encoded.top,
                encoded.display_scale
            ),
            (37, 69, -404, 2.0)
        );
        let mut status = ScrollStatus::new(uuid::Uuid::new_v4());
        status.content_origin = -808;
        status.revision = 7;
        publish_preview(&mut status, Some(encoded.clone()));
        // Current document geometry must not relabel an older PNG.
        let detail = status.detail_preview.as_ref().unwrap();
        assert_eq!((detail.revision, detail.top), (5, -404));
        let mut revisited = encoded.clone();
        revisited.top = 120;
        publish_preview(&mut status, Some(revisited));
        assert_eq!(status.detail_preview.as_ref().unwrap().top, 120);
        let mut obsolete = encoded;
        obsolete.revision = 4;
        publish_preview(&mut status, Some(obsolete));
        publish_preview(&mut status, None);
        let retained = status.detail_preview.as_ref().unwrap();
        assert_eq!((retained.revision, retained.top), (5, 120));
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                retained
                    .image
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().to_rgba8(), image);
    }

    #[test]
    fn busy_preview_encoder_does_not_build_or_queue_more_images() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let preview = PreviewSender {
            sender,
            available: Arc::new(AtomicBool::new(true)),
        };
        assert!(preview.try_submit(|| Some(DetailFrame {
            revision: 1,
            left: 0,
            top: 0,
            display_scale: 2.0,
            image: RgbaImage::new(1, 1),
        })));
        assert!(!preview.try_submit(|| panic!("a busy encoder must skip image construction")));
        receiver.recv().unwrap();
        // Receiving is not sufficient: the encoder must finish before a new
        // document snapshot can occupy memory or consume stitching time.
        assert!(!preview.try_submit(|| panic!("the running encode still owns the permit")));
        preview.available.store(true, Ordering::Release);
        assert!(!preview.try_submit(|| None));
        assert!(preview.available.load(Ordering::Acquire));
        drop(receiver);
        assert!(!preview.try_submit(|| Some(DetailFrame {
            revision: 1,
            left: 0,
            top: 0,
            display_scale: 2.0,
            image: RgbaImage::new(1, 1),
        })));
        assert!(preview.available.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_rejects_pending_finish_and_commit_is_single_flight() {
        let mut requests = Requests::default();
        let (reply, receive) = mpsc::channel();
        requests
            .finish(FinishRequest {
                since: Instant::now(),
                allow_partial: false,
                reply,
            })
            .unwrap();
        requests.cancel().unwrap();
        assert!(receive.recv().unwrap().is_err());
        let (reply, _) = mpsc::channel();
        assert!(requests
            .finish(FinishRequest {
                since: Instant::now(),
                allow_partial: false,
                reply
            })
            .is_err());
        let mut requests = Requests {
            saving: true,
            ..Requests::default()
        };
        assert!(requests.cancel().is_err());
    }
    #[test]
    fn pending_finish_stays_exclusive_while_native_stop_and_drain_owns_request() {
        let mut requests = Requests::default();
        let make_request = || {
            let (reply, receive) = mpsc::channel();
            (
                FinishRequest {
                    since: Instant::now(),
                    allow_partial: false,
                    reply,
                },
                receive,
            )
        };
        let (first, first_reply) = make_request();
        requests.finish(first).unwrap();
        let in_flight = requests.finish.take().unwrap();
        let (duplicate, _) = make_request();
        assert!(requests.finish(duplicate).is_err());
        assert!(
            requests.finish.is_none(),
            "an in-flight request must not enqueue a second save"
        );
        requests.finish_failed();
        in_flight.reply.send(Err("save failed".into())).unwrap();
        assert!(first_reply.recv().unwrap().is_err());
        let (retry, retry_reply) = make_request();
        requests.finish(retry).unwrap();
        requests.cancel().unwrap();
        assert_eq!(retry_reply.recv().unwrap().unwrap_err(), INACTIVE);
    }

    #[test]
    fn restarting_a_source_has_its_own_first_frame_deadline_without_discarding_document() {
        let id = uuid::Uuid::new_v4();
        let session = Session {
            id,
            requests: Mutex::new(Requests::default()),
            status: Mutex::new(ScrollStatus::new(id)),
            panel_geometry: test_panel_geometry(),
            window_labels: vec![PANEL.to_string(), REGION.to_string()],
            closing: AtomicBool::new(false),
            cleanup_complete: AtomicBool::new(false),
        };
        let mut stitcher = Stitcher::new(32, 64).unwrap();
        assert!(!stitcher.first_frame_timed_out(Duration::from_secs(8)));
        assert!(stitcher.first_frame_timed_out(Duration::from_secs(9)));
        let pixels = vec![127; 32 * 64 * 4];
        let make_frame = || ScrollFrame {
            pixels: pixels.clone(),
            width: 32,
            height: 64,
            stride: 128,
            sequence: 1,
            captured_at: Instant::now(),
            dropped_frames: 0,
        };
        stitcher.accept(make_frame(), &session).unwrap();
        let saved = stitcher.document.image().unwrap();
        assert!(
            !stitcher.first_frame_timed_out(Duration::from_secs(60)),
            "idle SCK is healthy after its first frame"
        );
        stitcher.reset_source_sequence();
        assert_eq!(stitcher.document.frame_count(), 1);
        assert_eq!(stitcher.document.image().unwrap(), saved);
        assert!(
            stitcher.first_frame_timed_out(Duration::from_secs(9)),
            "an older document cannot mask a stalled replacement source"
        );
        stitcher.accept(make_frame(), &session).unwrap();
        assert!(!stitcher.first_frame_timed_out(Duration::from_secs(60)));
        assert_eq!(stitcher.document.image().unwrap(), saved);
    }

    #[test]
    fn revisiting_updates_detail_direction_without_growing_document_and_unmatched_keeps_pixels() {
        let id = uuid::Uuid::new_v4();
        let session = Session {
            id,
            requests: Mutex::new(Requests::default()),
            status: Mutex::new(ScrollStatus::new(id)),
            panel_geometry: test_panel_geometry(),
            window_labels: vec![PANEL.to_string(), REGION.to_string()],
            closing: AtomicBool::new(false),
            cleanup_complete: AtomicBool::new(false),
        };
        let page = RgbaImage::from_fn(192, 900, |x, y| {
            let mut value = (u64::from(y) + 1).wrapping_mul(0x9e37_79b9);
            value ^= (u64::from(x) + 3).wrapping_mul(0x85eb_ca6b);
            value ^= value >> 16;
            image::Rgba([
                (value >> 3) as u8,
                (value >> 11) as u8,
                (value >> 19) as u8,
                255,
            ])
        });
        let native_frame = |image: RgbaImage, sequence| {
            let (width, height) = image.dimensions();
            let mut pixels = image.into_raw();
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            ScrollFrame {
                pixels,
                width,
                height,
                stride: width as usize * 4,
                sequence,
                captured_at: Instant::now(),
                dropped_frames: 0,
            }
        };
        let frame_at = |top, sequence| {
            native_frame(
                image::imageops::crop_imm(&page, 0, top, 192, 240).to_image(),
                sequence,
            )
        };
        let mut stitcher = Stitcher::new(192, 240).unwrap();
        stitcher.accept(frame_at(300, 1), &session).unwrap();
        stitcher.accept(frame_at(420, 2), &session).unwrap();
        assert_eq!(stitcher.revision, 2);
        assert!(!stitcher.detail_follows_top);
        stitcher.accept(frame_at(360, 3), &session).unwrap();
        assert!(stitcher.connected);
        assert_eq!(stitcher.document.viewport(), (60, 240));
        assert_eq!(
            stitcher.revision, 2,
            "a revisit must not advance the document revision"
        );
        assert!(stitcher.detail_follows_top);
        let accepted_viewport = stitcher.document.viewport();
        let accepted = stitcher.document.preview_region(0, 0, 192, 360).unwrap();
        stitcher
            .accept(
                native_frame(
                    RgbaImage::from_pixel(192, 240, image::Rgba([0, 0, 0, 255])),
                    4,
                ),
                &session,
            )
            .unwrap();
        assert!(!stitcher.connected);
        assert_eq!(stitcher.revision, 2);
        assert_eq!(stitcher.document.viewport(), accepted_viewport);
        assert_eq!(
            stitcher.document.preview_region(0, 0, 192, 360).unwrap(),
            accepted
        );
        stitcher.accept(frame_at(180, 5), &session).unwrap();
        assert!(stitcher.connected);
        assert_eq!(stitcher.revision, 3);
        assert_eq!(session.status.lock().unwrap().content_origin, -120);
        assert_eq!(
            stitcher.document.preview_region(0, 0, 192, 480).unwrap(),
            image::imageops::crop_imm(&page, 0, 180, 192, 480).to_image()
        );
    }

    #[test]
    fn raw_frame_conversion_respects_stride_and_odd_dimensions() {
        let image = rgba(ScrollFrame {
            pixels: vec![3, 2, 1, 0, 6, 5, 4, 0, 9, 8, 7, 0, 99, 99, 99, 99],
            width: 3,
            height: 1,
            stride: 16,
            sequence: 1,
            captured_at: Instant::now(),
            dropped_frames: 0,
        })
        .unwrap();
        assert_eq!(
            image.into_raw(),
            vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]
        );
    }
}
