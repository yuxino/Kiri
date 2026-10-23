use crate::qr_controller::Scan;
use crate::{
    commands::{asset_dto, AssetDto, RectDto},
    core::asset::CaptureKind,
    qr::{self, QrCode},
    state::{emit_library_changed, AppState},
};
use base64::Engine;
use serde::Serialize;
use std::{io::Read, sync::Arc};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDto {
    request_id: String,
    image_url: String,
    width: u32,
    height: u32,
    codes: Vec<QrCode>,
}

#[tauri::command]
pub async fn scan_qr(
    window: WebviewWindow,
    app: AppHandle,
    request_id: String,
    selection: Option<RectDto>,
    asset_id: Option<String>,
    expected_revision_sha256: Option<String>,
) -> Result<ScanDto, String> {
    let id = uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid QR request.")?;
    let label = window.label().to_string();
    let image_owner = asset_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(|_| "Invalid image.")?;
    validate_editor_revision_request(
        &label,
        image_owner,
        selection.is_some(),
        expected_revision_sha256.as_deref(),
    )?;
    let owner = if image_owner
        .is_some_and(|id| crate::qr_controller::image_owner_matches(&label, id))
        && selection.is_none()
    {
        None
    } else if asset_id.is_none() && selection.is_some() {
        Some(crate::ocr_commands::require_active_overlay(&window, &app)?)
    } else {
        return Err("QR recognition is unavailable from this window.".into());
    };
    let state = app.state::<AppState>();
    let requests = state.qr_requests.clone();
    let identity = {
        let context = state.library.lock().unwrap();
        (
            context.expected_library_id(),
            context.expected_library_generation(),
        )
    };
    let permit = requests.begin(
        label.clone(),
        Scan {
            id,
            capture_id: owner.as_ref().map(|o| o.capture_id),
            asset_id: image_owner,
            library_identity: identity,
            png: Arc::from([]),
            codes: vec![],
        },
    )?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let png = if let Some(selection) = selection {
            let source = {
                let state = app.state::<AppState>();
                let capture = state.capture.lock().unwrap();
                let session = capture
                    .session
                    .as_ref()
                    .filter(|s| {
                        Some(s.capture_id) == owner.as_ref().map(|o| o.capture_id)
                            && s.overlay_labels.contains(&label)
                    })
                    .ok_or("The QR request was canceled.")?;
                crate::ocr_commands::FrozenPngSource {
                    png: session.display.png_data.clone(),
                    declared_width: session.display.pixel_width,
                    declared_height: session.display.pixel_height,
                    display_width: session.display.screen_frame.width,
                    display_height: session.display.screen_frame.height,
                    scale: session.display.backing_scale,
                }
            };
            crate::ocr_commands::crop_frozen_png(source, selection)?.png
        } else {
            let id = uuid::Uuid::parse_str(asset_id.as_deref().ok_or("Invalid image.")?)
                .map_err(|_| "Invalid image.")?;
            let state = app.state::<AppState>();
            let mut context = state.library.lock().unwrap();
            if (
                context.expected_library_id(),
                context.expected_library_generation(),
            ) != identity
            {
                return Err("The library changed during QR recognition.".into());
            }
            let library = context.library().map_err(|e| e.to_string())?;
            let asset = library
                .asset_by_id(&id)
                .filter(|a| a.kind == CaptureKind::Image && a.trashed_at.is_none())
                .ok_or("Choose a screenshot from the library.")?;
            if let Some(revision) = expected_revision_sha256.as_deref() {
                editor_qr_source(library, &id, revision)?
            } else {
                let path = library
                    .readable_asset_url(asset)
                    .map_err(|e| e.to_string())?;
                let mut png = Vec::new();
                std::fs::File::open(path)
                    .map_err(|_| "The QR image could not be read.")?
                    .take(qr::MAX_PNG_BYTES as u64 + 1)
                    .read_to_end(&mut png)
                    .map_err(|_| "The QR image could not be read.")?;
                png
            }
        };
        let (width, height, codes) = qr::decode(&png)?;
        let image_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        let state = app.state::<AppState>();
        // Capture teardown and cancellation must not publish a stale result.
        let capture = state.capture.lock().unwrap();
        if let Some(owner) = &owner {
            if !capture.session.as_ref().is_some_and(|s| {
                s.capture_id == owner.capture_id && s.overlay_labels.contains(&label)
            }) {
                requests.clear(&label);
                return Err("The QR request was canceled.".into());
            }
        }
        let context = state.library.lock().unwrap();
        if (
            context.expected_library_id(),
            context.expected_library_generation(),
        ) != identity
        {
            requests.cancel(&label, id);
            return Err("The library changed during QR recognition.".into());
        }
        requests.publish(&label, id, Arc::from(png), codes.clone())?;
        Ok(ScanDto {
            request_id,
            image_url,
            width,
            height,
            codes,
        })
    })
    .await
    .map_err(|_| "QR recognition failed.".to_string())?;
    result
}

fn validate_editor_revision_request(
    label: &str,
    asset_id: Option<uuid::Uuid>,
    has_selection: bool,
    expected_revision: Option<&str>,
) -> Result<(), String> {
    let Some(revision) = expected_revision else {
        return Ok(());
    };
    if has_selection || asset_id.is_none_or(|id| label != format!("editor-{id}")) {
        return Err("QR recognition is unavailable from this window.".into());
    }
    if revision.len() != 64
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("The screenshot changed after the editor opened.".into());
    }
    Ok(())
}

fn editor_qr_source(
    library: &crate::core::library::AssetLibrary,
    id: &uuid::Uuid,
    expected_revision: &str,
) -> Result<Vec<u8>, String> {
    let snapshot = library.load_editor_snapshot(id).map_err(|e| e.to_string())?;
    if snapshot.revision_sha256 != expected_revision {
        return Err("The screenshot changed after the editor opened.".into());
    }
    // Use the same content-addressed clean source shown by annotation-source.
    // Unsaved marks, text drafts and pending crops stay entirely in the editor.
    Ok(snapshot.source)
}

#[tauri::command]
pub fn cancel_qr(window: WebviewWindow, app: AppHandle, request_id: String) {
    let state = app.state::<AppState>();
    if let Ok(id) = uuid::Uuid::parse_str(&request_id) {
        state.qr_requests.cancel(window.label(), id);
    }
}

fn selected(
    window: &WebviewWindow,
    app: &AppHandle,
    request_id: &str,
    index: usize,
) -> Result<(Scan, QrCode), String> {
    let state = app.state::<AppState>();
    let capture = state.capture.lock().unwrap();
    let scans = state.qr_requests.scans.lock().unwrap();
    let scan = scans
        .get(window.label())
        .filter(|s| s.id.to_string() == request_id)
        .ok_or("The QR request was canceled.")?;
    if let Some(id) = scan.capture_id {
        if !capture.session.as_ref().is_some_and(|s| {
            s.capture_id == id && s.overlay_labels.iter().any(|l| l == window.label())
        }) {
            return Err("The QR request was canceled.".into());
        }
    } else if !scan
        .asset_id
        .is_some_and(|id| crate::qr_controller::image_owner_matches(window.label(), id))
    {
        return Err("QR recognition is unavailable from this window.".into());
    }
    let context = state.library.lock().unwrap();
    if (
        context.expected_library_id(),
        context.expected_library_generation(),
    ) != scan.library_identity
    {
        return Err("The library changed during QR recognition.".into());
    }
    let code = scan
        .codes
        .get(index)
        .filter(|c| c.text.is_some())
        .ok_or("This QR code could not be decoded.")?
        .clone();
    Ok((scan.clone(), code))
}

#[tauri::command]
pub async fn qr_action(
    window: WebviewWindow,
    app: AppHandle,
    request_id: String,
    index: usize,
    action: String,
) -> Result<Option<AssetDto>, String> {
    let (scan, code) = selected(&window, &app, &request_id, index)?;
    let text = code
        .text
        .as_deref()
        .ok_or("This QR code could not be decoded.")?;
    match action.as_str() {
        "copy" => {
            crate::platform::write_text_to_clipboard(text).map_err(|e| e.to_string())?;
            Ok(None)
        }
        "open" => {
            open_link(&app, text, Some((window, request_id, index))).await?;
            Ok(None)
        }
        "favorite" | "unfavorite" => {
            let label = window.label().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let crop = if action == "favorite" {
                    Some(qr::crop_code(&scan.png, &code)?)
                } else {
                    None
                };
                let state = app.state::<AppState>();
                let capture = state.capture.lock().unwrap();
                let scans = state.qr_requests.scans.lock().unwrap();
                let request_current = scans.get(&label).is_some_and(|s| s.id == scan.id)
                    && scan.capture_id.is_none_or(|id| {
                        capture.session.as_ref().is_some_and(|s| {
                            s.capture_id == id && s.overlay_labels.contains(&label)
                        })
                    });
                let mut context = state.library.lock().unwrap();
                // selected() already accepted Favorite with a frozen PNG and
                // payload. Closing its result does not retract that explicit
                // save, but it must never write to a replacement library.
                validate_qr_favorite_save(
                    &action,
                    request_current,
                    scan.library_identity,
                    (
                        context.expected_library_id(),
                        context.expected_library_generation(),
                    ),
                )?;
                let library = context.library_mut().map_err(|e| e.to_string())?;
                let asset = if let Some((png, width, height)) = crop {
                    Some(
                        library
                            .import_qr(&png, width as i64, height as i64, code.text.unwrap())
                            .map_err(|e| e.to_string())?,
                    )
                } else {
                    if let Some(asset) = library
                        .all_assets(false)
                        .iter()
                        .find(|a| a.qr_text == code.text)
                    {
                        library
                            .move_to_trash(&asset.id)
                            .map_err(|e| e.to_string())?;
                    }
                    None
                };
                drop(context);
                drop(scans);
                drop(capture);
                emit_library_changed(&app);
                Ok(asset.as_ref().map(asset_dto))
            })
            .await
            .map_err(|_| "Could not save this QR code.".to_string())?
        }
        _ => Err("Invalid QR action.".into()),
    }
}

fn validate_qr_favorite_save(
    action: &str,
    request_current: bool,
    expected_library: (uuid::Uuid, uuid::Uuid),
    current_library: (uuid::Uuid, uuid::Uuid),
) -> Result<(), String> {
    if action == "unfavorite" && !request_current {
        return Err("The QR request was canceled.".into());
    }
    if expected_library != current_library {
        return Err("The library changed during QR recognition.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_qr_favorites(
    window: WebviewWindow,
    app: AppHandle,
    query: String,
) -> Result<Vec<AssetDto>, String> {
    if window.label() != "library" {
        return Err("QR favorites are only available from the library.".into());
    }
    let state = app.state::<AppState>();
    let mut context = state.library.lock().unwrap();
    Ok(context
        .library()
        .map_err(|e| e.to_string())?
        .search(&query, false)
        .iter()
        .filter(|a| a.qr_text.is_some() && a.is_favorite)
        .map(asset_dto)
        .collect())
}

#[tauri::command]
pub async fn qr_favorite_action(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    if window.label() != "library" {
        return Err("QR favorites are only available from the library.".into());
    }
    let id = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid QR favorite.")?;
    let text = {
        let state = app.state::<AppState>();
        let mut context = state.library.lock().unwrap();
        let library = context.library_mut().map_err(|e| e.to_string())?;
        let asset = library
            .asset_by_id(&id)
            .filter(|a| a.trashed_at.is_none() && a.is_favorite && a.qr_text.is_some())
            .ok_or("Invalid QR favorite.")?;
        let text = asset.qr_text.clone().unwrap();
        if action == "remove" {
            library.move_to_trash(&id).map_err(|e| e.to_string())?;
        }
        text
    };
    match action.as_str() {
        "copy" => crate::platform::write_text_to_clipboard(&text).map_err(|e| e.to_string()),
        "copyImage" => crate::commands::copy_asset(app, window, id.to_string()),
        "open" => open_link(&app, &text, None).await,
        "remove" => {
            emit_library_changed(&app);
            Ok(())
        }
        _ => Err("Invalid QR action.".into()),
    }
}

#[cfg(not(target_os = "linux"))]
async fn open_link(
    app: &AppHandle,
    text: &str,
    owner: Option<(WebviewWindow, String, usize)>,
) -> Result<(), String> {
    let url = qr::link(text)
        .ok_or("Only explicit HTTP or HTTPS links without credentials can be opened.")?
        .to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if let Some((window, request_id, index)) = owner {
                // Ownership may change while this command waits for the main
                // thread. Revalidate before hiding or closing any capture.
                let (scan, code) = selected(&window, &app_handle, &request_id, index)?;
                let url = code
                    .text
                    .as_deref()
                    .and_then(qr::link)
                    .ok_or("Only explicit HTTP or HTTPS links without credentials can be opened.")?
                    .to_string();
                if let Some(capture_id) = scan.capture_id {
                    return crate::commands::open_capture_link(
                        &window,
                        &app_handle,
                        capture_id,
                        || open_web_url(&url),
                    );
                }
                return open_web_url(&url);
            }
            open_web_url(&url)
        })();
        let _ = tx.send(result);
    })
    .map_err(|_| "Could not open this link.")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "Could not open this link.".to_string())?
    })
    .await
    .map_err(|_| "Could not open this link.".to_string())?
}

#[cfg(target_os = "linux")]
async fn open_link(
    app: &AppHandle,
    text: &str,
    owner: Option<(WebviewWindow, String, usize)>,
) -> Result<(), String> {
    let url = qr::link(text)
        .ok_or("Only explicit HTTP or HTTPS links without credentials can be opened.")?
        .to_string();
    let app_handle = app.clone();
    let prepare_owner = owner.clone();
    let (url, prepared) = on_main_thread(app, move || {
        let Some((window, request_id, index)) = prepare_owner else {
            return Ok((url, None));
        };
        let (scan, code) = selected(&window, &app_handle, &request_id, index)?;
        let url = code
            .text
            .as_deref()
            .and_then(qr::link)
            .ok_or("Only explicit HTTP or HTTPS links without credentials can be opened.")?
            .to_string();
        let prepared = scan
            .capture_id
            .map(|id| crate::commands::prepare_capture_link(&window, &app_handle, id))
            .transpose()?;
        Ok((url, prepared))
    })
    .await?;
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let mut command = std::process::Command::new("xdg-open");
        command
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        wait_for_link_launcher(command, std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|_| "Could not open this link.".to_string())
    .and_then(|result| result);
    let app_handle = app.clone();
    on_main_thread(app, move || {
        let owner_valid: Result<(), String> = (|| {
            if let Some((window, request_id, index)) = owner {
                let (scan, _) = selected(&window, &app_handle, &request_id, index)?;
                if scan.capture_id != prepared.as_ref().map(|token| token.capture_id) {
                    return Err("The QR request was canceled.".into());
                }
            }
            Ok(())
        })();
        // A canceled/replaced QR request still needs to unhide its capture.
        // The token guard prevents restoring a different, newer session.
        let finished = if let Some(prepared) = prepared {
            crate::commands::finish_capture_link(
                &app_handle,
                prepared,
                opened.is_ok() && owner_valid.is_ok(),
            )
        } else {
            Ok(())
        };
        owner_valid?;
        finished?;
        opened
    })
    .await
}

#[cfg(target_os = "linux")]
async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(action());
    })
    .map_err(|_| "Could not open this link.")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|_| "Could not open this link.".to_string())?
    })
    .await
    .map_err(|_| "Could not open this link.".to_string())?
}

#[cfg(any(target_os = "linux", test))]
fn wait_for_link_launcher(
    mut command: std::process::Command,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let mut child = command
        .spawn()
        .map_err(|_| "Could not open this link.".to_string())?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Could not open this link.".into())
                };
            }
            Err(_) => {
                stop_link_launcher(&mut child);
                return Err("Could not open this link.".into());
            }
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            stop_link_launcher(&mut child);
            return Err("Could not open this link.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(any(target_os = "linux", test))]
fn stop_link_launcher(child: &mut std::process::Child) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(arguments) = std::fs::read(format!("/proc/{}/cmdline", child.id())) else {
            return;
        };
        let names: Vec<_> = arguments
            .split(|byte| *byte == 0)
            .take(2)
            .map(|argument| std::path::Path::new(std::ffi::OsStr::from_bytes(argument)).file_name())
            .collect();
        let xdg = Some(std::ffi::OsStr::new("xdg-open"));
        let is_launcher = names.first().copied() == Some(xdg)
            || (names.get(1).copied() == Some(xdg)
                && names.first().copied().flatten().is_some_and(|name| {
                    ["sh", "dash", "bash", "busybox"]
                        .iter()
                        .any(|shell| name == std::ffi::OsStr::new(shell))
                }));
        // xdg-open may have exec'd the browser. Only terminate a child that
        // still identifies as the launcher, never the destination application.
        if is_launcher && child.kill().is_ok() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = child;
}

#[cfg(not(target_os = "linux"))]
fn open_web_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url =
            objc2_foundation::NSURL::URLWithString(&objc2_foundation::NSString::from_str(url))
                .ok_or("Could not open this link.")?;
        if !objc2_app_kit::NSWorkspace::sharedWorkspace().openURL(&url) {
            return Err("Could not open this link.".into());
        }
    }
    #[cfg(windows)]
    {
        use windows::{
            core::PCWSTR,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err("Could not open this link.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_qr_favorite_save;

    #[test]
    fn editor_revision_is_accepted_only_from_its_matching_image_editor() {
        let id = uuid::Uuid::new_v4();
        let revision = "a".repeat(64);
        let editor = format!("editor-{id}");
        assert!(super::validate_editor_revision_request(&editor, Some(id), false, Some(&revision)).is_ok());
        for (label, asset, selected) in [
            ("library".to_string(), Some(id), false),
            ("overlay".to_string(), None, true),
            (format!("editor-{}", uuid::Uuid::new_v4()), Some(id), false),
            (editor.clone(), Some(id), true),
        ] {
            assert!(super::validate_editor_revision_request(&label, asset, selected, Some(&revision)).is_err());
        }
        for invalid in ["", "a", &"A".repeat(64), &"g".repeat(64)] {
            assert!(super::validate_editor_revision_request(&editor, Some(id), false, Some(invalid)).is_err());
        }
        assert!(super::validate_editor_revision_request("library", Some(id), false, None).is_ok());
    }

    #[test]
    fn editor_qr_scans_its_exact_clean_source_and_rejects_a_changed_revision() {
        use crate::core::{asset::CaptureKind, library::AssetLibrary};
        let dir = tempfile::tempdir().unwrap();
        let mut library = AssetLibrary::open(dir.path().to_path_buf()).unwrap();
        let document = serde_json::json!({
            "schemaVersion": 1,
            "canvas": { "width": 100, "height": 80 },
            "sourcePixels": { "width": 100, "height": 80 },
            "marks": [],
        });
        let asset = library.import_data_with_annotation_project(
            b"flattened-with-annotations", CaptureKind::Image, "png", 100, 80,
            None, None, None, b"clean-source", &document,
        ).unwrap();
        let snapshot = library.load_editor_snapshot(&asset.id).unwrap();
        assert_eq!(super::editor_qr_source(&library, &asset.id, &snapshot.revision_sha256).unwrap(), b"clean-source");
        library.save_editor_snapshot(&asset.id, &snapshot.revision_sha256, b"changed-flat", Some(&document)).unwrap();
        assert_eq!(super::editor_qr_source(&library, &asset.id, &snapshot.revision_sha256).unwrap_err(), "The screenshot changed after the editor opened.");
        let current = library.load_editor_snapshot(&asset.id).unwrap();
        assert_eq!(super::editor_qr_source(&library, &asset.id, &current.revision_sha256).unwrap(), b"clean-source");
    }

    #[cfg(unix)]
    #[test]
    fn launcher_success_and_failure_follow_the_exit_status() {
        for (status, succeeds) in [(0, true), (7, false)] {
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg(format!("exit {status}"));
            assert_eq!(
                super::wait_for_link_launcher(command, std::time::Duration::from_secs(1)).is_ok(),
                succeeds,
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn missing_launcher_is_an_open_failure() {
        let command = std::process::Command::new("/kiri-missing-link-launcher");
        assert!(super::wait_for_link_launcher(command, std::time::Duration::from_secs(1)).is_err());
    }

    #[test]
    fn accepted_favorite_survives_result_close_but_unfavorite_requires_its_owner() {
        let identity = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        assert!(validate_qr_favorite_save("favorite", false, identity, identity).is_ok());
        assert!(validate_qr_favorite_save("unfavorite", false, identity, identity).is_err());
    }

    #[test]
    fn accepted_favorite_cannot_write_to_a_replacement_library_or_generation() {
        let identity = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        for replacement in [
            (uuid::Uuid::new_v4(), identity.1),
            (identity.0, uuid::Uuid::new_v4()),
        ] {
            assert!(validate_qr_favorite_save("favorite", false, identity, replacement).is_err());
        }
    }
}
