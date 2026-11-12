//! Signed updater integration and fixed recovery routes.

mod download;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::Channel, Manager, Resource, ResourceId, Webview};
use tauri_plugin_updater::Update;

static OPERATION_ACTIVE: AtomicBool = AtomicBool::new(false);
struct Operation;
impl Operation {
    fn begin() -> Result<Self, String> {
        OPERATION_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "An update operation is already running.".into())
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        OPERATION_ACTIVE.store(false, Ordering::Release);
    }
}

struct VerifiedPackage {
    bytes: Vec<u8>,
    artifact_key: String,
}
impl Resource for VerifiedPackage {}

fn artifact(update: &Update) -> download::Artifact<'_> {
    download::Artifact {
        version: &update.version,
        target: &update.target,
        url: update.download_url.as_str(),
        signature: &update.signature,
    }
}

fn require_updater(webview: &Webview) -> Result<(), String> {
    if webview.label() != "library" || cfg!(target_os = "linux") || is_portable_build() {
        return Err("This command is unavailable from this window.".into());
    }
    Ok(())
}

fn public_key(webview: &Webview) -> Result<String, String> {
    webview
        .app_handle()
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "The updater is not configured.".into())
}

#[tauri::command]
pub async fn download_app_update(
    webview: Webview,
    rid: ResourceId,
    on_event: Channel<download::DownloadEvent>,
) -> Result<ResourceId, download::DownloadError> {
    require_updater(&webview).map_err(|_| download::DownloadError::empty())?;
    let _operation = Operation::begin().map_err(|_| download::DownloadError::empty())?;
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|_| download::DownloadError::empty())?;
    let key = public_key(&webview).map_err(|_| download::DownloadError::empty())?;
    let directory = webview
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| download::DownloadError::empty())?
        .join("updates");
    let client = download::client_builder()
        .build()
        .map_err(|_| download::DownloadError::empty())?;
    let artifact = artifact(&update);
    let bytes = download::download(&client, &directory, &artifact, &key, |event| {
        let _ = on_event.send(event);
    })
    .await?;
    Ok(webview.resources_table().add(VerifiedPackage {
        bytes,
        artifact_key: artifact.key(),
    }))
}

#[tauri::command]
pub async fn install_app_update(
    webview: Webview,
    update_rid: ResourceId,
    bytes_rid: ResourceId,
) -> Result<(), String> {
    require_updater(&webview)?;
    let _operation = Operation::begin()?;
    let update = webview
        .resources_table()
        .get::<Update>(update_rid)
        .map_err(|_| "The update is no longer available.".to_string())?;
    let package = webview
        .resources_table()
        .get::<VerifiedPackage>(bytes_rid)
        .map_err(|_| "Download and verify the update first.".to_string())?;
    let key = public_key(&webview)?;
    let directory = webview
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| "The update cache is unavailable.".to_string())?
        .join("updates");
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = _operation;
        if artifact(&update).key() != package.artifact_key
            || download::verify(&package.bytes, &update.signature, &key).is_err()
        {
            return Err("The update signature is invalid. Download it again.".to_string());
        }
        // Windows exits inside install. Clear the disk copy first; the verified
        // resource remains available for an explicit retry if installation fails.
        if download::clear_cache(&directory).is_err() {
            log::warn!("[updates] could not remove the completed download cache");
        }
        (*update)
            .clone()
            .restart_after_install(true)
            .install(&package.bytes)
            .map_err(|_| "Couldn't install the update. Try again.".to_string())
    })
    .await
    .map_err(|_| "Couldn't install the update. Try again.".to_string())??;
    let _ = webview.resources_table().close(bytes_rid);
    Ok(())
}

const RELEASE_PAGE: &str = "https://github.com/yuxino/kiri/releases/latest";

#[tauri::command]
pub fn open_project_page(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "library" {
        return Err("This command is unavailable from this window.".into());
    }
    open_external_url("https://github.com/yuxino/Kiri").map_err(|error| {
        log::warn!("Could not open project page: {error}");
        "Couldn't open the project page.".into()
    })
}

#[tauri::command]
pub fn is_portable_build() -> bool {
    #[cfg(windows)]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("kiri.portable")))
            .is_some_and(|marker| marker.is_file())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn open_release_page() -> Result<(), String> {
    open_external_url(RELEASE_PAGE).map_err(|error| {
        log::warn!("[updates] could not open release page: {error}");
        "Couldn't open the update page.".to_string()
    })
}

#[cfg(target_os = "macos")]
fn open_external_url(url: &str) -> Result<(), String> {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let url = objc2_foundation::NSURL::URLWithString(&objc2_foundation::NSString::from_str(url))
        .ok_or_else(|| "the release URL is invalid".to_string())?;
    if workspace.openURL(&url) {
        Ok(())
    } else {
        Err("the release page could not be opened".to_string())
    }
}

#[cfg(windows)]
fn open_external_url(url: &str) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn open_external_url(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
