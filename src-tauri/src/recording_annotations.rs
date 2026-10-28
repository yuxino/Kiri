//! Session-owned live marks. Only the ink window enters the recorded image;
//! editing handles, text input and controls remain capture-excluded.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::core::annotation::{AnnotationColor, AnnotationDocument, AnnotationMark, AnnotationPixelSize,
    AnnotationSize, TextBackground};
use crate::state::{AppState, RecordingFlow};
#[cfg(not(target_os = "linux"))]
use crate::state::RecordingConfiguration;

pub const INPUT_WINDOW: &str = "recording-annotation-input";
pub const INK_WINDOW: &str = "recording-annotation-ink";
const UNAVAILABLE: &str = "Live annotations are unavailable for this recording.";
const MAX_LIVE_MARKS: usize = 256;
const MAX_LIVE_POINTS: usize = 20_000;
const MAX_LIVE_TEXT: usize = 8_192;
const STOP_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(600);

struct StopFlush {
    request_id: uuid::Uuid,
    revision: Option<u64>,
    completion: Option<std::sync::mpsc::Sender<bool>>,
}

impl StopFlush {
    fn complete(&mut self, success: bool) {
        if let Some(completion) = self.completion.take() { let _ = completion.send(success); }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationTool {
    #[default]
    Desktop,
    Select,
    Pen,
    Arrow,
    Rectangle,
    Text,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationAction { Undo, Redo, Clear, EditText, Delete }

#[derive(Default)]
pub struct RecordingAnnotations {
    available: bool,
    input_ready: bool,
    ink_ready: bool,
    tool: AnnotationTool,
    can_undo: bool,
    can_redo: bool,
    has_marks: bool,
    marks: Vec<AnnotationMark>,
    revision: u64,
    return_pid: Option<u32>,
    error: Option<String>,
    used: bool,
    stop_flush: Option<StopFlush>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSnapshot {
    session_id: uuid::Uuid,
    supported: bool,
    available: bool,
    ready: bool,
    tool: AnnotationTool,
    can_undo: bool,
    can_redo: bool,
    has_marks: bool,
    marks: Vec<AnnotationMark>,
    revision: u64,
    error: Option<String>,
}

impl RecordingAnnotations {
    fn ready(&self) -> bool { self.available && self.input_ready && self.ink_ready }

    fn snapshot(&self, session_id: uuid::Uuid) -> AnnotationSnapshot {
        AnnotationSnapshot {
            session_id, supported: !cfg!(target_os = "linux"), available: self.available,
            ready: self.ready(), tool: self.tool, can_undo: self.can_undo,
            can_redo: self.can_redo, has_marks: self.has_marks, marks: self.marks.clone(),
            revision: self.revision, error: self.error.clone(),
        }
    }

    fn apply_marks(&mut self, revision: u64, marks: Vec<AnnotationMark>,
        can_undo: bool, can_redo: bool, has_marks: bool) -> bool {
        if revision <= self.revision { return false; }
        self.revision = revision;
        self.marks = marks;
        self.can_undo = can_undo;
        self.can_redo = can_redo;
        self.has_marks = has_marks || !self.marks.is_empty();
        true
    }

    pub(crate) fn owns_stop_flush(&self, request_id: Option<uuid::Uuid>) -> bool {
        self.stop_flush.as_ref().is_some_and(|pending| Some(pending.request_id) == request_id)
    }

    fn accept_flush_revision(&mut self, request_id: uuid::Uuid, revision: Option<u64>) -> bool {
        let Some(pending) = self.stop_flush.as_mut().filter(|pending| pending.request_id == request_id) else { return false; };
        match revision {
            Some(revision) if revision <= self.revision => { pending.revision = Some(revision); true }
            _ => { pending.complete(false); false }
        }
    }

    fn acknowledge_presented(&mut self, request_id: uuid::Uuid, revision: u64) {
        if let Some(pending) = self.stop_flush.as_mut().filter(|pending| pending.request_id == request_id) {
            if pending.revision.is_some_and(|target| revision >= target && revision <= self.revision) {
                pending.complete(true);
            }
        }
    }

    fn mark_unavailable(&mut self) {
        let mut pending = self.stop_flush.take();
        if let Some(pending) = &mut pending { pending.complete(false); }
        let revision = self.revision.saturating_add(1);
        *self = Self { error: Some(UNAVAILABLE.into()), revision, stop_flush: pending, ..Default::default() };
    }
}

pub(crate) enum StopPreparation {
    Immediate,
    AlreadyStopping,
    Prepared { session_id: uuid::Uuid, request_id: uuid::Uuid },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlushEvent { session_id: uuid::Uuid, request_id: uuid::Uuid }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresentEvent { session_id: uuid::Uuid, request_id: uuid::Uuid, revision: u64 }

/// Await renderer IPC only from async stop entry points. The native event loop
/// remains free to accept the final vector frame and its paint acknowledgement.
pub(crate) async fn flush_before_stop(app: &AppHandle, expected_session: Option<uuid::Uuid>) -> StopPreparation {
    let (session_id, request_id, completion) = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        if !flow.accepts_recording_action(expected_session) || flow.annotations.stop_flush.is_some() {
            return StopPreparation::AlreadyStopping;
        }
        if flow.is_starting || flow.is_transitioning || flow.is_finalizing
            || !(flow.is_recording || flow.is_paused) || !flow.annotations.ready() || !flow.annotations.used {
            return StopPreparation::Immediate;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let request_id = uuid::Uuid::new_v4();
        flow.annotations.stop_flush = Some(StopFlush { request_id, revision: None, completion: Some(sender) });
        flow.is_transitioning = true;
        crate::state::emit_recording_state(app, &flow);
        (flow.session_id, request_id, receiver)
    };
    // Let the renderer freeze its in-progress gesture before changing native
    // hit testing, which can otherwise cancel the final pointer draft.
    let sent = app.emit_to(INPUT_WINDOW, "recording-annotation-flush", FlushEvent { session_id, request_id }).is_ok();
    let presented = if sent {
        let waiter = tauri::async_runtime::spawn_blocking(move || wait_for_flush(completion, STOP_FLUSH_TIMEOUT));
        // Include blocking-pool queue time in the deadline as well.
        tokio::time::timeout(STOP_FLUSH_TIMEOUT, waiter).await.ok().and_then(Result::ok).unwrap_or(false)
    } else { false };
    if presented {
        // One capture interval after compositor presentation keeps the final
        // painted ink in a native frame before the source is stopped.
        tokio::time::sleep(std::time::Duration::from_millis(34)).await;
    } else {
        log::warn!("recording annotation final-frame flush did not complete before stop");
    }
    StopPreparation::Prepared { session_id, request_id }
}

fn wait_for_flush(completion: std::sync::mpsc::Receiver<bool>, timeout: std::time::Duration) -> bool {
    completion.recv_timeout(timeout).unwrap_or(false)
}

#[tauri::command]
pub fn recording_annotations_flushed(app: AppHandle, window: WebviewWindow, session_id: uuid::Uuid,
    request_id: uuid::Uuid, revision: Option<u64>) -> Result<(), String> {
    require_caller(&window, true)?;
    let (owned, accepted) = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        let owned = flow.session_id == session_id && !flow.is_finalizing
            && flow.annotations.owns_stop_flush(Some(request_id));
        (owned, owned && flow.annotations.accept_flush_revision(request_id, revision))
    };
    if owned {
        if let Some(input) = owned_window(&app, INPUT_WINDOW, session_id) {
            let _ = input.set_ignore_cursor_events(true);
        }
    }
    if accepted {
        app.emit_to(INK_WINDOW, "recording-annotation-present", PresentEvent {
            session_id, request_id, revision: revision.unwrap(),
        }).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn recording_annotations_presented(app: AppHandle, window: WebviewWindow, session_id: uuid::Uuid,
    request_id: uuid::Uuid, revision: u64) -> Result<(), String> {
    if window.label() != INK_WINDOW { return Err("This command is unavailable from this window.".into()); }
    let state = app.state::<AppState>();
    let mut flow = state.recording.lock().unwrap();
    if flow.session_id == session_id && !flow.is_finalizing {
        flow.annotations.acknowledge_presented(request_id, revision);
    }
    Ok(())
}

fn require_caller(window: &WebviewWindow, input_only: bool) -> Result<(), String> {
    if window.label() == INPUT_WINDOW || (!input_only && matches!(window.label(), "control-panel" | INK_WINDOW)) {
        Ok(())
    } else { Err("This command is unavailable from this window.".into()) }
}

fn require_session(flow: &RecordingFlow, session_id: uuid::Uuid) -> Result<(), String> {
    if flow.session_id == session_id && flow.configuration.is_some() && !flow.is_finalizing {
        Ok(())
    } else { Err("This recording is no longer active.".into()) }
}

fn publish(app: &AppHandle, snapshot: &AnnotationSnapshot) {
    // Session consumers subscribe before hydrating, so a renderer that loads
    // after startup never misses the current tool or existing marks.
    for label in ["control-panel", INPUT_WINDOW, INK_WINDOW] {
        let _ = app.emit_to(label, "recording-annotations-state", snapshot);
    }
}

/// Remember only the current external app while the user operates the
/// desktop. This uses the recording clock and requires no input monitor.
#[cfg(not(target_os = "linux"))]
pub fn remember_desktop_focus(app: &AppHandle, session_id: uuid::Uuid) {
    {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        if flow.session_id != session_id || !flow.annotations.available
            || flow.annotations.tool != AnnotationTool::Desktop || flow.is_finalizing { return; }
    }
    let Some(pid) = crate::platform::frontmost_application().map(|(pid, _)| pid)
        .filter(|pid| *pid != std::process::id()) else { return; };
    let state = app.state::<AppState>();
    let mut flow = state.recording.lock().unwrap();
    if flow.session_id == session_id && flow.annotations.available
        && flow.annotations.tool == AnnotationTool::Desktop && !flow.is_finalizing {
        flow.annotations.return_pid = Some(pid);
    }
}

#[tauri::command]
pub fn get_recording_annotations(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid) -> Result<AnnotationSnapshot, String> {
    require_caller(&window, false)?;
    let state = app.state::<AppState>();
    let flow = state.recording.lock().unwrap();
    require_session(&flow, session_id)?;
    Ok(flow.annotations.snapshot(session_id))
}

#[tauri::command]
pub fn recording_annotations_ready(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid) -> Result<AnnotationSnapshot, String> {
    if !matches!(window.label(), INPUT_WINDOW | INK_WINDOW) {
        return Err("This command is unavailable from this window.".into());
    }
    let snapshot = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if window.label() == INPUT_WINDOW { flow.annotations.input_ready = true; }
        else { flow.annotations.ink_ready = true; }
        flow.annotations.snapshot(session_id)
    };
    publish(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn set_recording_annotation_tool(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid, tool: AnnotationTool) -> Result<AnnotationSnapshot, String> {
    require_caller(&window, false)?;
    if window.label() == INK_WINDOW { return Err("This command is unavailable from this window.".into()); }
    let frontmost = crate::platform::frontmost_application().map(|(pid, _)| pid);
    let (previous, return_pid) = {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if !flow.annotations.ready() || flow.is_starting || flow.is_transitioning
            || !(flow.is_recording || flow.is_paused) {
            return Err(UNAVAILABLE.into());
        }
        (flow.annotations.tool, flow.annotations.return_pid.or(flow.return_pid))
    };
    let input = app.get_webview_window(INPUT_WINDOW).ok_or(UNAVAILABLE)?;
    // Native calls must run without the recording lock: AppKit/Win32 calls
    // can synchronously dispatch to the application thread.
    if tool == AnnotationTool::Desktop {
        input.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
        // Keep this already-open WebView rendering until its text-commit and
        // last ink frame have flushed. The renderer hides editing chrome;
        // the native window is pointer-transparent and remains excluded.
    } else {
        input.set_ignore_cursor_events(false).map_err(|error| error.to_string())?;
        if let Err(error) = input.show().and_then(|_| input.set_focus()) {
            let _ = input.set_ignore_cursor_events(true);
            let _ = input.hide();
            return Err(error.to_string());
        }
        crate::platform::show_window_without_activation(&app, "control-panel",
            crate::platform::TransientWindowRole::RecordingControls);
    }
    let snapshot = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if previous == AnnotationTool::Desktop && tool != AnnotationTool::Desktop {
            flow.annotations.return_pid = frontmost.filter(|pid| *pid != std::process::id()).or(return_pid);
        }
        flow.annotations.tool = tool;
        flow.annotations.used |= tool != AnnotationTool::Desktop;
        flow.annotations.snapshot(session_id)
    };
    publish(&app, &snapshot);
    if tool == AnnotationTool::Desktop && previous != AnnotationTool::Desktop
        && frontmost == Some(std::process::id()) {
        if let Some(pid) = return_pid.filter(|pid| *pid != std::process::id()) {
            crate::platform::activate_application(pid);
        }
    }
    Ok(snapshot)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionEvent { session_id: uuid::Uuid, action: AnnotationAction }

#[tauri::command]
pub fn recording_annotation_action(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid, action: AnnotationAction) -> Result<(), String> {
    require_caller(&window, false)?;
    if window.label() == INK_WINDOW { return Err("This command is unavailable from this window.".into()); }
    {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if !flow.annotations.ready() || !(flow.is_recording || flow.is_paused) || flow.is_transitioning {
            return Err(UNAVAILABLE.into());
        }
    }
    app.emit_to(INPUT_WINDOW, "recording-annotation-action", ActionEvent { session_id, action })
        .map_err(|error| error.to_string())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveAppearancePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    color_preset: Option<AnnotationColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pen_width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shape_width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_font_size: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_background_style: Option<TextBackground>,
}

impl LiveAppearancePatch {
    fn validate(&self) -> Result<(), String> {
        if self.pen_width.is_some_and(|value| !(1..=24).contains(&value))
            || self.shape_width.is_some_and(|value| !(1..=16).contains(&value))
            || self.text_font_size.is_some_and(|value| !(12..=64).contains(&value)) {
            return Err("The annotation appearance is invalid.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceEvent {
    session_id: uuid::Uuid,
    patch: LiveAppearancePatch,
    transient: bool,
    finish: bool,
}

#[tauri::command]
pub fn update_recording_annotation_appearance(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid, patch: LiveAppearancePatch, transient: bool, finish: bool) -> Result<(), String> {
    require_caller(&window, false)?;
    if window.label() == INK_WINDOW { return Err("This command is unavailable from this window.".into()); }
    patch.validate()?;
    {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if !flow.annotations.ready() || !(flow.is_recording || flow.is_paused) || flow.is_transitioning {
            return Err(UNAVAILABLE.into());
        }
    }
    app.emit_to(INPUT_WINDOW, "recording-annotation-appearance",
        AppearanceEvent { session_id, patch, transient, finish }).map_err(|error| error.to_string())
}

fn validate_marks(marks: Vec<AnnotationMark>, size: AnnotationSize) -> Result<Vec<AnnotationMark>, String> {
    if marks.len() > MAX_LIVE_MARKS { return Err("Too many live annotations. Clear some marks to continue.".into()); }
    let mut points = 0usize;
    let mut text = 0usize;
    for mark in &marks {
        match mark {
            AnnotationMark::Pen { points: mark_points, .. } => points = points.saturating_add(mark_points.len()),
            AnnotationMark::Text { text: mark_text, .. } => text = text.saturating_add(mark_text.encode_utf16().count()),
            AnnotationMark::Arrow { .. } | AnnotationMark::Rectangle { .. } => {},
            _ => return Err("This annotation tool is unavailable while recording.".into()),
        }
    }
    if points > MAX_LIVE_POINTS || text > MAX_LIVE_TEXT {
        return Err("Too many live annotations. Clear some marks to continue.".into());
    }
    let document = AnnotationDocument {
        schema_version: 1, canvas: size,
        source_pixels: AnnotationPixelSize { width: size.width.ceil() as u32, height: size.height.ceil() as u32 },
        marks,
    };
    document.validate()?;
    if serde_json::to_vec(&document).map_err(|error| error.to_string())?.len() > 1024 * 1024 {
        return Err("Too many live annotations. Clear some marks to continue.".into());
    }
    Ok(document.marks)
}

#[tauri::command]
pub fn update_recording_annotations(app: AppHandle, window: WebviewWindow,
    session_id: uuid::Uuid, revision: u64, marks: Vec<AnnotationMark>,
    can_undo: bool, can_redo: bool, has_marks: bool) -> Result<(), String> {
    require_caller(&window, true)?;
    if revision > 9_007_199_254_740_991 { return Err("Invalid annotation revision.".into()); }
    let size = {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if revision <= flow.annotations.revision { return Ok(()); }
        let region = flow.configuration.as_ref().unwrap().region;
        AnnotationSize { width: region.width, height: region.height }
    };
    let marks = validate_marks(marks, size)?;
    let snapshot = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        require_session(&flow, session_id)?;
        if !flow.annotations.available { return Err(UNAVAILABLE.into()); }
        if !flow.annotations.apply_marks(revision, marks, can_undo, can_redo, has_marks) { return Ok(()); }
        flow.annotations.snapshot(session_id)
    };
    publish(&app, &snapshot);
    Ok(())
}

/// Optional live editing must never prevent an otherwise valid recording.
#[cfg(not(target_os = "linux"))]
pub fn prepare(app: &AppHandle, configuration: &RecordingConfiguration, session_id: uuid::Uuid) {
    let mut created = Vec::new();
    let result = create_windows(app, configuration, session_id, &mut created);
    if let Err(error) = &result {
        log::warn!("recording annotations unavailable: {error}");
        for window in &created { let _ = window.close(); }
    }
    let snapshot = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        if require_session(&flow, session_id).is_err() {
            drop(flow);
            for window in &created { let _ = window.close(); }
            return;
        }
        flow.annotations.available = result.is_ok();
        flow.annotations.error = result.err().map(|_| UNAVAILABLE.into());
        flow.annotations.snapshot(session_id)
    };
    publish(app, &snapshot);
    if snapshot.available {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(15));
            let timed_out = {
                let state = handle.state::<AppState>();
                let flow = state.recording.lock().unwrap();
                flow.session_id == session_id && flow.annotations.available && !flow.annotations.ready()
            };
            if timed_out {
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || disable(&app, session_id, true));
            }
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn disable(app: &AppHandle, session_id: uuid::Uuid, only_loading: bool) {
    let (snapshot, return_pid) = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        if flow.session_id != session_id || !flow.annotations.available
            || (only_loading && flow.annotations.ready()) { return; }
        let return_pid = flow.annotations.return_pid.or(flow.return_pid);
        flow.annotations.mark_unavailable();
        (flow.annotations.snapshot(session_id), return_pid)
    };
    publish(app, &snapshot);
    for label in [INPUT_WINDOW, INK_WINDOW] {
        if let Some(window) = owned_window(app, label, session_id) {
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.hide();
            let _ = window.close();
        }
    }
    if crate::platform::frontmost_application().map(|(pid, _)| pid) == Some(std::process::id()) {
        if let Some(pid) = return_pid.filter(|pid| *pid != std::process::id()) {
            crate::platform::activate_application(pid);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn create_windows(app: &AppHandle, configuration: &RecordingConfiguration,
    session_id: uuid::Uuid, created: &mut Vec<WebviewWindow>) -> Result<(), String> {
    use crate::platform::{self, TransientWindowRole};
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    #[cfg(windows)]
    {
        let controls = app.get_webview_window("control-panel").ok_or(UNAVAILABLE)?;
        platform::windows::require_window_capture_exclusion(&controls).map_err(|error| error.to_string())?;
    }
    let region = configuration.region;
    let frame = crate::core::geometry::Rect::new(configuration.screen_frame.x + region.x,
        configuration.screen_frame.y + region.y, region.width, region.height);
    for (label, role) in [(INK_WINDOW, TransientWindowRole::RecordingAnnotationInk),
        (INPUT_WINDOW, TransientWindowRole::RecordingAnnotationInput)] {
        {
            let state = app.state::<AppState>();
            let flow = state.recording.lock().unwrap();
            require_session(&flow, session_id)?;
        }
        let window = WebviewWindowBuilder::new(app, label,
            WebviewUrl::App(format!("index.html?window={label}&session={session_id}&width={}&height={}", region.width, region.height).into()))
            .title("kiri").inner_size(frame.width, frame.height).position(frame.x, frame.y)
            .visible(false).focused(false).focusable(label == INPUT_WINDOW).decorations(false)
            .transparent(true).always_on_top(true).skip_taskbar(true).shadow(false)
            .build().map_err(|error| error.to_string())?;
        created.push(window.clone());
        platform::place_transient_window(&window, frame, configuration.backing_scale)
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        {
            platform::windows::pin_webview_to_display_scale(&window, configuration.backing_scale);
            if label == INPUT_WINDOW {
                platform::windows::require_window_capture_exclusion(&window).map_err(|error| error.to_string())?;
            }
        }
        window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) { disable(&handle, session_id, false); }
        });
        platform::configure_transient_window(&window, role);
        // configure_transient_window may order a macOS window front; hide the
        // input again before capture, while keeping ink discoverable by SCK.
        if label == INPUT_WINDOW { window.hide().map_err(|error| error.to_string())?; }
        else { window.show().map_err(|error| error.to_string())?; }
    }
    Ok(())
}

fn owned_window(app: &AppHandle, label: &str, session_id: uuid::Uuid) -> Option<WebviewWindow> {
    let window = app.get_webview_window(label)?;
    let url = window.url().ok()?;
    let owns_session = url.query_pairs().any(|(key, value)| key == "session" && value == session_id.to_string());
    owns_session.then_some(window)
}

#[cfg(target_os = "macos")]
pub fn capture_window_id(app: &AppHandle) -> Option<u32> {
    let session_id = {
        let state = app.state::<AppState>();
        let flow = state.recording.lock().unwrap();
        if !flow.annotations.available || flow.is_finalizing { return None; }
        flow.session_id
    };
    owned_window(app, INK_WINDOW, session_id)?;
    crate::platform::window_capture_id(app, INK_WINDOW)
}

/// Stop taking input immediately, but preserve the last recorded pixels until
/// the native recorder and encoder have drained their final frames.
pub fn release_input(app: &AppHandle, session_id: uuid::Uuid) {
    if let Some(window) = owned_window(app, INPUT_WINDOW, session_id) {
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.hide();
    }
}

pub fn close(app: &AppHandle, session_id: uuid::Uuid) {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut flow = state.recording.lock().unwrap();
        if flow.session_id == session_id {
            let revision = flow.annotations.revision.saturating_add(1);
            flow.annotations = RecordingAnnotations { revision, ..Default::default() };
            Some(flow.annotations.snapshot(session_id))
        } else { None }
    };
    if let Some(snapshot) = snapshot { publish(app, &snapshot); }
    for label in [INPUT_WINDOW, INK_WINDOW] {
        if let Some(window) = owned_window(app, label, session_id) {
            // Restore mouse input even if a platform delays destruction.
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.hide();
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::annotation::AnnotationPoint;

    fn pen(id: f64, points: usize) -> AnnotationMark {
        AnnotationMark::Pen { id, points: vec![AnnotationPoint { x: 10.0, y: 10.0 }; points],
            color: AnnotationColor::Cherry, width: 3.0 }
    }
    fn size() -> AnnotationSize { AnnotationSize { width: 800.0, height: 600.0 } }

    #[test]
    fn live_marks_reuse_geometry_and_identity_validation() {
        assert!(validate_marks(vec![pen(1.0, 2)], size()).is_ok());
        assert!(validate_marks(vec![pen(-1.0, 2)], size()).is_err());
        assert!(validate_marks(vec![pen(1.0, 2), pen(1.0, 1)], size()).is_err());
        assert!(validate_marks(vec![pen(1.0, MAX_LIVE_POINTS + 1)], size()).is_err());
        let mut mark = pen(2.0, 1);
        if let AnnotationMark::Pen { points, .. } = &mut mark { points[0].x = f64::NAN; }
        assert!(validate_marks(vec![mark], size()).is_err());
    }

    #[test]
    fn unsupported_live_tools_are_rejected() {
        let line = AnnotationMark::Line { id: 1.0, start: AnnotationPoint { x: 0.0, y: 0.0 },
            end: AnnotationPoint { x: 1.0, y: 1.0 }, color: AnnotationColor::Cherry, width: 3.0 };
        assert!(validate_marks(vec![line], size()).is_err());
    }

    #[test]
    fn readiness_requires_both_surfaces_and_successful_exclusion() {
        let mut state = RecordingAnnotations::default();
        state.input_ready = true;
        state.ink_ready = true;
        assert!(!state.ready());
        state.available = true;
        assert!(state.ready());
        state.ink_ready = false;
        assert!(!state.ready());
    }

    #[test]
    fn delayed_marks_cannot_restore_a_cleared_frame() {
        let mut state = RecordingAnnotations::default();
        assert!(state.apply_marks(4, vec![pen(1.0, 1)], true, false, true));
        assert!(state.apply_marks(6, vec![], true, false, false));
        assert!(!state.apply_marks(5, vec![pen(1.0, 1)], true, false, true));
        assert!(!state.apply_marks(6, vec![pen(1.0, 1)], true, false, true));
        assert!(state.marks.is_empty());
        assert!(!state.has_marks);
    }

    #[test]
    fn session_reset_clears_marks_and_rejects_old_window_calls() {
        let mut flow = RecordingFlow::default();
        let old_session = uuid::Uuid::new_v4();
        flow.session_id = old_session;
        flow.annotations.apply_marks(1, vec![pen(1.0, 1)], true, false, true);
        flow.annotations.tool = AnnotationTool::Pen;
        flow.take_and_reset();
        assert!(require_session(&flow, old_session).is_err());
        assert!(flow.annotations.marks.is_empty());
        assert_eq!(flow.annotations.tool, AnnotationTool::Desktop);
    }

    #[test]
    fn appearance_relay_accepts_only_supported_bounded_fields() {
        let valid: LiveAppearancePatch = serde_json::from_str(r#"{"colorPreset":"cherry","penWidth":24,"shapeWidth":16,"textFontSize":64,"textBackgroundStyle":"dark"}"#).unwrap();
        assert!(valid.validate().is_ok());
        let oversized: LiveAppearancePatch = serde_json::from_str(r#"{"textFontSize":65}"#).unwrap();
        assert!(oversized.validate().is_err());
        let zero: LiveAppearancePatch = serde_json::from_str(r#"{"penWidth":0}"#).unwrap();
        assert!(zero.validate().is_err());
        assert!(serde_json::from_str::<LiveAppearancePatch>(r#"{"mosaicBrushDiameter":20}"#).is_err());
        let finish: LiveAppearancePatch = serde_json::from_str("{}").unwrap();
        assert!(finish.validate().is_ok());
        assert_eq!(serde_json::to_string(&finish).unwrap(), "{}");
    }

    fn pending_stop(revision: u64) -> (RecordingAnnotations, uuid::Uuid, std::sync::mpsc::Receiver<bool>) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let request_id = uuid::Uuid::new_v4();
        (RecordingAnnotations { revision,
            stop_flush: Some(StopFlush { request_id, revision: None, completion: Some(sender) }),
            ..Default::default() }, request_id, receiver)
    }

    #[test]
    fn stop_waits_for_the_flushed_revision_to_be_painted() {
        let (mut state, request, completion) = pending_stop(7);
        assert!(state.accept_flush_revision(request, Some(7)));
        assert!(matches!(completion.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
        state.acknowledge_presented(request, 6);
        assert!(matches!(completion.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
        state.acknowledge_presented(request, 7);
        assert!(wait_for_flush(completion, std::time::Duration::ZERO));
    }

    #[test]
    fn old_flush_replies_cannot_complete_a_new_stop() {
        let (mut state, request, completion) = pending_stop(8);
        let old_request = uuid::Uuid::new_v4();
        assert!(!state.accept_flush_revision(old_request, Some(8)));
        state.acknowledge_presented(old_request, 8);
        assert!(!wait_for_flush(completion, std::time::Duration::ZERO));
        assert!(state.owns_stop_flush(Some(request)));
        assert!(!state.owns_stop_flush(Some(old_request)));
    }

    #[test]
    fn missing_or_failed_surface_never_holds_stop_open() {
        let (state, _, completion) = pending_stop(2);
        assert!(!wait_for_flush(completion, std::time::Duration::ZERO));
        drop(state);
        let (mut state, request, completion) = pending_stop(2);
        assert!(!state.accept_flush_revision(request, None));
        assert!(!wait_for_flush(completion, STOP_FLUSH_TIMEOUT));
        let (mut state, request, completion) = pending_stop(2);
        state.mark_unavailable();
        assert!(!wait_for_flush(completion, STOP_FLUSH_TIMEOUT));
        assert!(state.owns_stop_flush(Some(request)), "failed overlay must retain the stop permit");
    }
}
