//! Windows platform helpers — hotkey, focus, click monitoring, and capture
//! exclusion via Win32.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumWindows, GetForegroundWindow, GetMessageW,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PeekMessageW,
    PostThreadMessageW, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowsHookExW,
    ShowWindow, TranslateMessage, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    SW_RESTORE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WH_MOUSE_LL, WM_LBUTTONDOWN,
    WM_QUIT, WM_RBUTTONDOWN,
};

use super::{ClickMonitorHandle, MicrophoneAccess};

// ---------------------------------------------------------------------------
// Focus / reveal
// ---------------------------------------------------------------------------

pub fn activate_application(pid: u32) {
    if let Some(hwnd) = find_main_window(pid) {
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

pub fn show_window_without_activation(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        let _ = window.show();
        return;
    };
    unsafe {
        let _ = ShowWindow(HWND(hwnd.0 as *mut _), SW_SHOWNOACTIVATE);
    }
}

fn find_main_window(pid: u32) -> Option<HWND> {
    struct Search {
        pid: u32,
        found: Option<HWND>,
    }
    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        if search.found.is_some() {
            return windows::core::BOOL(0);
        }
        let mut window_pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
        }
        if window_pid == search.pid && unsafe { IsWindowVisible(hwnd).as_bool() } {
            search.found = Some(hwnd);
            return windows::core::BOOL(0);
        }
        windows::core::BOOL(1)
    }
    let mut search = Search { pid, found: None };
    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

pub fn reveal_path(path: &Path) -> Result<()> {
    // Shell paths are data, not Explorer command-line arguments. A comma,
    // space or non-ASCII character must not change the requested destination.
    // Use a fresh STA: Tauri's worker pool may already have an MTA apartment.
    let path = path.to_owned();
    thread::Builder::new()
        .name("kiri-reveal-file".into())
        .spawn(move || {
            use windows::core::{w, PCWSTR};
            use windows::Win32::System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            };
            use windows::Win32::UI::Shell::{
                ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems, ShellExecuteW,
            };
            use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
            let metadata = std::fs::metadata(&path)?;
            let encoded = shell_encoded_path(&path)?;
            unsafe {
                CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
            }
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
            let _apartment = Apartment;
            if metadata.is_dir() {
                let result = unsafe {
                    ShellExecuteW(
                        None,
                        w!("open"),
                        PCWSTR(encoded.as_ptr()),
                        PCWSTR::null(),
                        PCWSTR::null(),
                        SW_SHOWNORMAL,
                    )
                };
                if result.0 as isize <= 32 {
                    bail!("The capture folder could not be opened.");
                }
            } else {
                let item = unsafe { ILCreateFromPathW(PCWSTR(encoded.as_ptr())) };
                if item.is_null() {
                    bail!("The capture could not be located in its folder.");
                }
                // With no child array the full item PIDL selects the file in its
                // parent folder; directories above deliberately open themselves.
                let result = unsafe { SHOpenFolderAndSelectItems(item, None, 0) };
                unsafe {
                    ILFree(Some(item));
                }
                result?;
            }
            Ok(())
        })?
        .join()
        .map_err(|_| anyhow!("The file manager request did not finish."))?
}

fn shell_encoded_path(path: &Path) -> Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::PathCchStripPrefix;
    let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    if !path.is_absolute() || encoded.contains(&0) {
        bail!("The capture path is not an absolute local path.");
    }
    encoded.push(0);
    // Library migration persists canonicalized filesystem paths. The Shell
    // expects DOS/UNC paths rather than their \\?\ extended-length spelling.
    // Strip only that prefix through the native UTF-16 API, preserving names.
    unsafe {
        PathCchStripPrefix(&mut encoded).ok()?;
    }
    if let Some(end) = encoded.iter().position(|unit| *unit == 0) {
        encoded.truncate(end + 1);
    }
    Ok(encoded)
}

pub fn write_file_to_clipboard(path: &Path) -> Result<()> {
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{
        EmptyClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::DROPEFFECT_COPY;
    let mut clipboard = arboard::Clipboard::new()?;
    // The Set builder holds one OpenClipboard lock until file_list completes.
    // arboard's file_list does not clear old text or a previous Explorer cut
    // offer. Replace both formats under that same lock and request COPY.
    let offer = clipboard.set();
    unsafe {
        let format = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if format == 0 {
            return Err(windows::core::Error::from_thread().into());
        }
        let memory = GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u32>())?;
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            let error = windows::core::Error::from_thread();
            let _ = GlobalFree(Some(memory));
            return Err(error.into());
        }
        pointer.cast::<u32>().write(DROPEFFECT_COPY.0);
        let _ = GlobalUnlock(memory);
        let result =
            EmptyClipboard().and_then(|_| SetClipboardData(format, Some(HANDLE(memory.0))));
        if let Err(error) = result {
            let _ = GlobalFree(Some(memory));
            return Err(error.into());
        }
    }
    offer.file_list(&[path]).map_err(anyhow::Error::from)
}

pub fn frontmost_application() -> Option<(u32, Option<String>)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let name = window_title(hwnd);
        Some((pid, name))
    }
}

fn window_title(hwnd: HWND) -> Option<String> {
    unsafe {
        let length = GetWindowTextLengthW(hwnd) as usize;
        if length == 0 {
            return None;
        }
        let mut buffer = vec![0u16; length + 1];
        let written = GetWindowTextW(hwnd, &mut buffer);
        Some(String::from_utf16_lossy(&buffer[..written as usize]))
    }
}

pub fn activate_self() {
    // set_focus on the overlay window already foregrounds it.
}

pub fn mic_supported() -> bool {
    true
}

pub fn request_microphone_access() -> Result<MicrophoneAccess> {
    Ok(MicrophoneAccess::Authorized)
}

pub fn set_window_click_through(app: &tauri::AppHandle, label: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let hwnd = HWND(hwnd.0 as *mut _);
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let _ = SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            style | WS_EX_LAYERED.0 as isize | WS_EX_TRANSPARENT.0 as isize,
        );
    }
}

/// Windows' "text size" accessibility setting (Accessibility > Text size) is
/// folded into the WebView2 rasterization scale, so a page's CSS pixel no
/// longer maps to one display point. The capture overlay draws the frozen
/// screenshot in display points and must stay pixel-exact, so pin the webview
/// to the display's scale factor instead of the OS text scale.
pub fn pin_webview_to_display_scale(window: &tauri::WebviewWindow, display_scale: f64) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows_core::Interface;

    let scale = if display_scale.is_finite() && display_scale > 0.0 {
        display_scale
    } else {
        1.0
    };
    if let Err(error) = window.with_webview(move |platform| {
        let controller = platform.controller();
        let Ok(controller3) = controller.cast::<ICoreWebView2Controller3>() else {
            // Older WebView2 runtimes have no rasterization scale control; the
            // overlay keeps the legacy behavior there.
            return;
        };
        unsafe {
            // WebView2 re-derives the rasterization scale from the monitor DPI
            // multiplied by the system text scale, so stop the detection before
            // pinning the value.
            if let Err(error) = controller3.SetShouldDetectMonitorScaleChanges(false) {
                log::warn!(
                    "overlay webview automatic scale detection could not be disabled: {error}"
                );
                // Do not set a scale that WebView2 could immediately overwrite.
                return;
            }
            if let Err(error) = controller3.SetRasterizationScale(scale) {
                log::warn!("overlay webview scale could not be pinned: {error}");
            }
        }
    }) {
        log::warn!("overlay webview scale pinning could not be dispatched: {error}");
    }
}

pub fn set_window_capture_excluded(app: &tauri::AppHandle, label: &str, excluded: bool) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let affinity = if excluded {
            WDA_EXCLUDEFROMCAPTURE
        } else {
            WDA_NONE
        };
        let _ = SetWindowDisplayAffinity(HWND(hwnd.0 as *mut _), affinity);
    }
}

// ---------------------------------------------------------------------------
// Global click monitor (WH_MOUSE_LL)
// ---------------------------------------------------------------------------

type ClickCallback = Arc<dyn Fn(f64, f64) + Send + Sync>;

static CLICK_CALLBACK: Mutex<Option<ClickCallback>> = Mutex::new(None);

struct MessageLoopWorker {
    thread_id: Option<u32>,
    thread: Option<thread::JoinHandle<()>>,
}

impl MessageLoopWorker {
    fn shutdown(&mut self) {
        let Some(thread) = self.thread.take() else {
            self.thread_id = None;
            return;
        };

        if let Some(thread_id) = self.thread_id.take() {
            if let Err(error) = post_thread_quit(thread_id) {
                // A finished message loop has no queue, so a failed post is
                // harmless when the worker already exited. Joining below
                // still reaps it and makes shutdown deterministic.
                if !thread.is_finished() {
                    log::warn!("Windows click monitor could not request shutdown: {error}");
                }
            }
        }

        // A callback could theoretically own the final handle. Never join the
        // current thread; WM_QUIT will be consumed after that callback returns.
        if thread.thread().id() != thread::current().id() && thread.join().is_err() {
            log::warn!("Windows click monitor thread panicked during shutdown");
        }
    }
}

impl Drop for MessageLoopWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct ClickMonitor {
    worker: MessageLoopWorker,
}

impl ClickMonitor {
    fn shutdown(&mut self) {
        self.worker.shutdown();
    }
}

impl ClickMonitorHandle for ClickMonitor {
    fn stop(mut self: Box<Self>) {
        self.shutdown();
    }
}

impl Drop for ClickMonitor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn start_click_monitor(
    callback: Arc<dyn Fn(f64, f64) + Send + Sync>,
) -> Result<Box<dyn ClickMonitorHandle + Send>> {
    {
        let mut slot = CLICK_CALLBACK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() {
            bail!("The Windows click monitor is already running.");
        }
        *slot = Some(callback);
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel::<std::result::Result<u32, String>>(1);
    let installing_thread_id = Arc::new(AtomicU32::new(0));
    let thread_id_slot = Arc::clone(&installing_thread_id);
    let installation_cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_slot = Arc::clone(&installation_cancelled);
    let thread = match thread::Builder::new()
        .name("kiri-click-monitor".into())
        .spawn(move || run_click_monitor_loop(ready_tx, &thread_id_slot, &cancelled_slot))
    {
        Ok(thread) => thread,
        Err(error) => {
            clear_click_callback();
            return Err(error.into());
        }
    };

    let thread_id = match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(thread_id)) => thread_id,
        Ok(Err(error)) => {
            let _ = thread.join();
            return Err(anyhow!(error));
        }
        Err(error) => {
            installation_cancelled.store(true, Ordering::Release);
            let thread_id = installing_thread_id.load(Ordering::Acquire);
            let mut worker = MessageLoopWorker {
                thread_id: (thread_id != 0).then_some(thread_id),
                thread: Some(thread),
            };
            worker.shutdown();
            clear_click_callback();
            return Err(anyhow!(
                "Windows click monitor did not become ready: {error}"
            ));
        }
    };

    Ok(Box::new(ClickMonitor {
        worker: MessageLoopWorker {
            thread_id: Some(thread_id),
            thread: Some(thread),
        },
    }))
}

fn run_click_monitor_loop(
    ready_tx: mpsc::SyncSender<std::result::Result<u32, String>>,
    installing_thread_id: &AtomicU32,
    installation_cancelled: &AtomicBool,
) {
    unsafe {
        // Thread messages are delivered only after the receiver owns a message
        // queue. Create it before publishing the thread id so WM_QUIT cannot
        // race startup and disappear.
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        let thread_id = GetCurrentThreadId();
        installing_thread_id.store(thread_id, Ordering::Release);

        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) {
            Ok(hook) => hook,
            Err(error) => {
                let _ = ready_tx.send(Err(format!(
                    "The Windows click monitor hook could not be installed: {error}"
                )));
                clear_click_callback();
                return;
            }
        };

        if installation_cancelled.load(Ordering::Acquire) {
            let _ = UnhookWindowsHookEx(hook);
            clear_click_callback();
            return;
        }

        if ready_tx.send(Ok(thread_id)).is_err() {
            let _ = UnhookWindowsHookEx(hook);
            clear_click_callback();
            return;
        }

        loop {
            let status = GetMessageW(&mut message, None, 0, 0).0;
            if status == 0 {
                break;
            }
            if status == -1 {
                log::error!("Windows click monitor message loop failed");
                break;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        if let Err(error) = UnhookWindowsHookEx(hook) {
            log::warn!("Windows click monitor hook could not be removed: {error}");
        }
        clear_click_callback();
    }
}

fn post_thread_quit(thread_id: u32) -> windows::core::Result<()> {
    unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) }
}

fn clear_click_callback() {
    *CLICK_CALLBACK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN {
            let data = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let callback = CLICK_CALLBACK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(callback) = callback {
                callback(data.pt.x as f64, data.pt.y as f64);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_paths_preserve_names_and_remove_canonical_prefixes() {
        for (input, expected) in [
            (
                r"C:\素材 test, 🐈\Kiri Library",
                r"C:\素材 test, 🐈\Kiri Library",
            ),
            (
                r"\\?\C:\素材 test, 🐈\Kiri Library\Assets\说明.png",
                r"C:\素材 test, 🐈\Kiri Library\Assets\说明.png",
            ),
            (
                r"\\?\UNC\server\share\素材 test, 🐈\说明.png",
                r"\\server\share\素材 test, 🐈\说明.png",
            ),
        ] {
            let encoded = shell_encoded_path(Path::new(input)).unwrap();
            assert_eq!(encoded.last(), Some(&0));
            assert_eq!(
                String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
                expected
            );
        }
        assert!(shell_encoded_path(Path::new("relative.png")).is_err());
        assert!(shell_encoded_path(Path::new("C:\\bad\0path")).is_err());
    }

    #[test]
    fn message_loop_shutdown_wakes_joins_and_is_idempotent() {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || unsafe {
            let mut message = MSG::default();
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            ready_tx.send(GetCurrentThreadId()).unwrap();
            let stopped_by_quit = GetMessageW(&mut message, None, 0, 0).0 == 0;
            stopped_tx.send(stopped_by_quit).unwrap();
        });
        let thread_id = ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("test message loop should become ready");
        let mut worker = MessageLoopWorker {
            thread_id: Some(thread_id),
            thread: Some(thread),
        };

        worker.shutdown();
        worker.shutdown();

        assert!(stopped_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("WM_QUIT should wake the test message loop"));
        assert!(worker.thread_id.is_none());
        assert!(worker.thread.is_none());
    }
}
