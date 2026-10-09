//! One actor owns one connection/session, including every lifecycle transition.
use super::{
    model::{Snapshot, Status},
    portal::{Client, Error, Event},
    publish,
};
use std::{
    collections::HashSet,
    io::Write,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Setup,
    Configure,
    Refresh,
    Disconnect,
}
impl Operation {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "setup" => Ok(Self::Setup),
            "configure" => Ok(Self::Configure),
            "refresh" => Ok(Self::Refresh),
            "disconnect" => Ok(Self::Disconnect),
            _ => Err("Invalid desktop shortcut operation.".into()),
        }
    }
}
pub struct Command {
    pub kind: Operation,
    pub cancel: CancellationToken,
    pub reply: oneshot::Sender<Result<Snapshot, String>>,
}

fn restore_enabled(app: &tauri::AppHandle) -> bool {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("portal-shortcuts.txt")).ok())
        .is_some_and(|value| value == "enabled\n")
}

fn save_enabled(app: &tauri::AppHandle, enabled: bool) -> std::io::Result<()> {
    let dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    std::fs::create_dir_all(&dir)?;
    let mut file = tempfile::NamedTempFile::new_in(&dir)?;
    file.write_all(if enabled { b"enabled\n" } else { b"disabled\n" })?;
    file.as_file().sync_all()?;
    file.persist(dir.join("portal-shortcuts.txt"))?;
    Ok(())
}

fn descriptions(app: &tauri::AppHandle) -> [String; 3] {
    let language = crate::core::locale::preferred_language(
        &crate::state::load_language(app),
        &crate::commands::get_locale(),
    );
    crate::core::locale::shortcut_descriptions(language).map(str::to_owned)
}

fn apply_bindings(
    app: &tauri::AppHandle,
    state: &Mutex<Snapshot>,
    bindings: Vec<(String, Option<String>)>,
    version: u32,
) -> std::io::Result<()> {
    let mut candidate = state.lock().unwrap().clone();
    candidate.apply(bindings.clone(), version);
    // Configuration can add bindings after an initially empty/declined set,
    // or after revoke-all. Persist both directions, before publishing success.
    save_enabled(app, candidate.any_bound())?;
    publish(app, state, |s| s.apply(bindings, version));
    Ok(())
}

async fn connect(app: &tauri::AppHandle, state: &Mutex<Snapshot>) -> Option<Client> {
    publish(app, state, |s| {
        s.clear(Status::Checking);
        s.available = false;
    });
    match Client::connect().await {
        Ok(client) => {
            publish(app, state, |s| {
                s.clear(Status::Ready);
                s.available = true;
            });
            Some(client)
        }
        Err(error) => {
            log::info!("[portal-shortcuts] unavailable: {error}");
            publish(app, state, |s| {
                s.clear(Status::Unavailable);
                s.available = false;
            });
            None
        }
    }
}

async fn deactivate(
    app: &tauri::AppHandle,
    state: &Mutex<Snapshot>,
    client: &mut Option<Client>,
    status: Status,
) {
    // Invalidate visible bindings BEFORE cleanup, which can itself time out.
    publish(app, state, |s| {
        s.clear(status);
        s.available = false;
    });
    if let Some(client) = client.take() {
        client.shutdown().await;
    }
}

async fn setup(
    app: &tauri::AppHandle,
    state: &Mutex<Snapshot>,
    client: &mut Option<Client>,
    cancel: &CancellationToken,
) {
    // A new BindShortcuts attempt always gets a new session (protocol limit:
    // BindShortcuts is permitted once per session).
    deactivate(app, state, client, Status::Connecting).await;
    *client = connect(app, state).await;
    let Some(active) = client.as_mut() else {
        return;
    };
    publish(app, state, |s| s.clear(Status::Connecting));
    let result = active.bind(&descriptions(app), cancel).await;
    // A reply and Cancel can become ready in the same poll. Cancellation must
    // win before a newly approved binding is published or persisted.
    let result = if cancel.is_cancelled() {
        Err(Error::Declined)
    } else {
        result
    };
    match result {
        Ok(bindings) => {
            let version = active.version;
            if let Err(error) = apply_bindings(app, state, bindings, version) {
                log::warn!("[portal-shortcuts] preference could not be saved: {error}");
                deactivate(app, state, client, Status::Failed).await;
            }
        }
        Err(error) => {
            log::info!("[portal-shortcuts] setup did not complete: {error}");
            let status = if matches!(error, Error::Declined) {
                Status::Declined
            } else {
                Status::Failed
            };
            let _ = save_enabled(app, false);
            deactivate(app, state, client, status).await;
        }
    }
}

async fn refresh(app: &tauri::AppHandle, state: &Mutex<Snapshot>, client: &mut Option<Client>) {
    let active = state.lock().unwrap().status == Status::Active;
    if active {
        if let Some(current) = client {
            publish(app, state, |s| s.clear(Status::Checking));
            match current.list().await {
                Ok(bindings) => {
                    if let Err(error) = apply_bindings(app, state, bindings, current.version) {
                        log::warn!("[portal-shortcuts] preference could not be saved: {error}");
                        deactivate(app, state, client, Status::Failed).await;
                    }
                    return;
                }
                Err(error) => log::warn!("[portal-shortcuts] refresh failed: {error}"),
            }
        }
        let _ = save_enabled(app, false);
        deactivate(app, state, client, Status::Closed).await;
    } else if client.is_none() {
        *client = connect(app, state).await;
    }
}

pub async fn run(
    app: tauri::AppHandle,
    state: Arc<Mutex<Snapshot>>,
    mut commands: mpsc::Receiver<Command>,
    startup_cancel: CancellationToken,
) {
    let restore = restore_enabled(&app);
    let mut client = connect(&app, &state).await;
    if restore && client.is_some() {
        // Only an earlier successful explicit setup opts in to restoration.
        // There is one startup attempt; denial/failure never loops a prompt.
        setup(&app, &state, &mut client, &startup_cancel).await;
    }
    let mut pressed = HashSet::new();
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                let mut error = None;
                match command.kind {
                    Operation::Setup => {
                        pressed.clear();
                        setup(&app, &state, &mut client, &command.cancel).await;
                    }
                    Operation::Refresh => refresh(&app, &state, &mut client).await,
                    Operation::Configure => {
                        if let Some(active) = &client {
                            if let Err(failure) = active.configure().await {
                                log::warn!("[portal-shortcuts] configuration UI unavailable: {failure}");
                                // Configure is not proof that a key is bound. Re-list
                                // even on failure before keeping any active status.
                                refresh(&app, &state, &mut client).await;
                                error = Some("Could not open desktop shortcut settings.".to_string());
                            }
                        } else { error = Some("Desktop shortcuts are unavailable in this session.".into()); }
                    }
                    Operation::Disconnect => {
                        if save_enabled(&app, false).is_err() {
                            error = Some("Could not save desktop shortcut settings.".into());
                        } else {
                            pressed.clear();
                            deactivate(&app, &state, &mut client, Status::Ready).await;
                        }
                    }
                }
                let snapshot = state.lock().unwrap().clone();
                let _ = command.reply.send(error.map_or(Ok(snapshot), Err));
            }
            event = async {
                match &mut client { Some(client) => client.next_event().await,
                    None => std::future::pending().await }
            } => {
                match event {
                    Ok(Event::Activated(id)) => {
                        if state.lock().unwrap().bound(&id) && pressed.insert(id.clone()) {
                            match id.as_str() {
                                "capture" => crate::schedule_capture_start(&app, "portal-shortcut"),
                                "pause-resume" => crate::linux_recording_action(&app, false),
                                "stop" => crate::linux_recording_action(&app, true),
                                _ => {},
                            }
                        }
                    }
                    Ok(Event::Deactivated(id)) => { pressed.remove(&id); }
                    Ok(Event::Changed) => {
                        pressed.clear();
                        refresh(&app, &state, &mut client).await;
                    }
                    Ok(Event::Other) => {},
                    _ => {
                        pressed.clear();
                        let _ = save_enabled(&app, false);
                        deactivate(&app, &state, &mut client, Status::Closed).await;
                        // Do not re-prompt after revocation/service failure.
                        // Reconnect is an explicit Settings action.
                    }
                }
            }
        }
    }
    if let Some(client) = client {
        client.shutdown().await;
    }
}
