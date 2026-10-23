//! Opt-in Wayland GlobalShortcuts, independent of native X11/macOS/Windows grabs.
#[cfg(target_os = "linux")]
mod linux;
mod model;
#[cfg(target_os = "linux")]
mod portal;

pub use model::Snapshot;
use model::Status;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use tauri::Emitter;
use tauri::{Manager, WebviewWindow};

pub struct Controller {
    snapshot: Arc<Mutex<Snapshot>>,
    #[cfg(target_os = "linux")]
    sender: Option<tokio::sync::mpsc::Sender<linux::Command>>,
    #[cfg(target_os = "linux")]
    cancellation: Arc<Mutex<Option<tokio_util::sync::CancellationToken>>>,
    #[cfg(target_os = "linux")]
    busy: std::sync::atomic::AtomicBool,
    #[cfg(target_os = "linux")]
    startup_cancel: tokio_util::sync::CancellationToken,
}

pub fn init(app: &tauri::AppHandle) {
    let snapshot = Arc::new(Mutex::new(Snapshot::new(Status::Unsupported)));
    #[cfg(target_os = "linux")]
    let (sender, cancellation, startup_cancel) = {
        let startup_cancel = tokio_util::sync::CancellationToken::new();
        let cancellation = Arc::new(Mutex::new(None));
        let sender = if crate::capture::linux::is_wayland() {
            snapshot.lock().unwrap().status = Status::Checking;
            let (sender, receiver) = tokio::sync::mpsc::channel(8);
            let app = app.clone();
            let state = snapshot.clone();
            tauri::async_runtime::spawn(linux::run(app, state, receiver, startup_cancel.clone()));
            Some(sender)
        } else {
            None
        };
        (sender, cancellation, startup_cancel)
    };
    app.manage(Controller {
        snapshot,
        #[cfg(target_os = "linux")]
        sender,
        #[cfg(target_os = "linux")]
        cancellation,
        #[cfg(target_os = "linux")]
        busy: std::sync::atomic::AtomicBool::new(false),
        #[cfg(target_os = "linux")]
        startup_cancel,
    });
}

fn require_library(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "library" {
        return Err("This command is unavailable from this window.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_portal_shortcuts(window: WebviewWindow) -> Result<Snapshot, String> {
    require_library(&window)?;
    Ok(window
        .state::<Controller>()
        .snapshot
        .lock()
        .unwrap()
        .clone())
}

/// Operation names are a closed vocabulary; neither commands nor binding IDs
/// from JavaScript are ever used to launch a process or choose a portal action.
#[tauri::command]
pub async fn update_portal_shortcuts(
    window: WebviewWindow,
    operation: String,
) -> Result<Snapshot, String> {
    require_library(&window)?;
    #[cfg(target_os = "linux")]
    {
        use std::sync::atomic::Ordering;
        let kind = linux::Operation::parse(&operation)?;
        if matches!(kind, linux::Operation::Setup | linux::Operation::Configure)
            && !window.is_focused().unwrap_or(false)
        {
            return Err("Open Settings to set up desktop shortcuts.".into());
        }
        let controller = window.state::<Controller>();
        let sender = controller
            .sender
            .as_ref()
            .ok_or("Desktop shortcuts are unavailable in this session.")?;
        if controller
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("A desktop shortcut request is already in progress.".into());
        }
        struct Permit<'a>(&'a Controller);
        impl Drop for Permit<'_> {
            fn drop(&mut self) {
                if let Some(cancel) = self.0.cancellation.lock().unwrap().take() {
                    cancel.cancel();
                }
                self.0.busy.store(false, Ordering::Release);
            }
        }
        let _permit = Permit(&controller);
        let cancel = tokio_util::sync::CancellationToken::new();
        if kind == linux::Operation::Setup {
            *controller.cancellation.lock().unwrap() = Some(cancel.clone());
        }
        let (reply, result) = tokio::sync::oneshot::channel();
        sender
            .try_send(linux::Command {
                kind,
                cancel,
                reply,
            })
            .map_err(|_| "Could not update desktop shortcuts.".to_string())?;
        result
            .await
            .map_err(|_| "Could not update desktop shortcuts.".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = operation;
        Err("Desktop shortcuts are unavailable in this session.".into())
    }
}

pub fn cancel_setup(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    if let Some(controller) = app.try_state::<Controller>() {
        controller.startup_cancel.cancel();
        if let Some(cancel) = controller.cancellation.lock().unwrap().as_ref() {
            cancel.cancel();
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[tauri::command]
pub fn cancel_portal_shortcut_setup(window: WebviewWindow) -> Result<(), String> {
    require_library(&window)?;
    cancel_setup(window.app_handle());
    Ok(())
}

#[cfg(target_os = "linux")]
fn publish(
    app: &tauri::AppHandle,
    state: &Mutex<Snapshot>,
    update: impl FnOnce(&mut Snapshot),
) -> Snapshot {
    let snapshot = {
        let mut state = state.lock().unwrap();
        update(&mut state);
        state.revision += 1;
        state.clone()
    };
    let _ = app.emit_to("library", "portal-shortcuts-changed", &snapshot);
    snapshot
}
