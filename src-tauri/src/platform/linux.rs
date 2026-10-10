//! Linux desktop integration through GTK/GIO and the X11 window-manager API.
//!
//! GTK owns clipboard offers for the lifetime of the main loop. In particular,
//! GNOME Wayland does not expose the wlroots data-control clipboard protocol.
//! Wayland focus and global shortcuts remain under the compositor's control.

use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use gtk::glib::variant::ToVariant;
use gtk::prelude::*;
use tauri::Manager;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, EventMask};

use super::{ClickMonitorHandle, MicrophoneAccess};
use crate::core::geometry::Rect;

#[derive(Clone, Copy)]
struct X11FocusTarget {
    window: u32,
    pid: u32,
}

static CAPTURE_FOCUS_TARGET: Mutex<Option<X11FocusTarget>> = Mutex::new(None);

pub fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
        || std::env::var_os("WAYLAND_SOCKET").is_some_and(|socket| !socket.is_empty())
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|session| session.eq_ignore_ascii_case("wayland"))
}

/// GTK's non-resizable windows also constrain programmatic resize requests.
/// Keep native resizing enabled and give the window manager the same fixed
/// aspect as the web grip, before the reference is mapped for the first time.
pub fn show_pinned_screenshot(window: &tauri::WebviewWindow, width: f64, height: f64) -> Result<()> {
    let pending = Arc::new(Mutex::new(Some(window.clone())));
    let scheduled = pending.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    // build() returns before Wry processes its CreateWindow message. Use the
    // same Tauri event queue, not a separate GLib idle callback which can run
    // before the native window has entered Wry's registry.
    window.run_on_main_thread(move || {
        let Some(window) = scheduled.lock().unwrap().take() else { return };
        let result: Result<()> = (|| {
            let native = window
                .gtk_window()
                .context("Could not access the pinned screenshot window.")?;
            let aspect = width / height;
            let geometry = gtk::gdk::Geometry::new(
                80, 60, 0, 0, 0, 0, 0, 0, aspect, aspect, gtk::gdk::Gravity::NorthWest,
            );
            native.set_geometry_hints(
                None::<&gtk::Widget>,
                Some(&geometry),
                // Otherwise GTK uses the minimum as the base and X11 applies
                // the aspect to (size - base), rather than the whole frame.
                gtk::gdk::WindowHints::MIN_SIZE
                    | gtk::gdk::WindowHints::BASE_SIZE
                    | gtk::gdk::WindowHints::ASPECT,
            );
            native.show_all();
            native.present();
            native.display().sync();
            Ok(())
        })();
        let _ = sender.send(result);
    }).context("Could not schedule the pinned screenshot window.")?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => {
            pending.lock().unwrap().take();
            Err(anyhow!("Pinned screenshot initialization did not respond."))
        }
    }
}

/// Present the capture overlay only after its borderless native window has
/// been configured. Capture creation runs on GTK's main thread.
pub fn show_capture_overlay(window: &tauri::WebviewWindow, frame: Rect) -> Result<()> {
    if !gtk::is_initialized_main_thread() {
        return Err(anyhow!(
            "Capture windows must be shown on the GTK main thread."
        ));
    }
    let native = window
        .gtk_window()
        .context("Could not access the capture window.")?;
    let wayland = is_wayland_session();
    if wayland {
        // Wayland controls top-level placement. The supported capture path
        // has one display, so request its full-screen canvas before mapping.
        native.fullscreen();
    } else {
        // A normal X11 top-level is constrained to the workarea even without
        // decorations: docks can shift its full-display canvas down and clip
        // the bottom. Request managed fullscreen before the first map, on the
        // captured monitor rather than whichever monitor GTK chooses by default.
        // This leaves panel struts and the user's window-manager policy intact.
        let screen = GtkWindowExt::screen(&native)
            .context("Could not access the capture screen.")?;
        let display = screen.display();
        let monitors = (0..display.n_monitors())
            .filter_map(|index| {
                display
                    .monitor(index)
                    .map(|monitor| (index, monitor.geometry()))
            })
            .collect::<Vec<_>>();
        let frames = monitors
            .iter()
            .map(|(_, bounds)| {
                Rect::new(
                    f64::from(bounds.x()),
                    f64::from(bounds.y()),
                    f64::from(bounds.width()),
                    f64::from(bounds.height()),
                )
            })
            .collect::<Vec<_>>();
        let index = capture_monitor_index(frame, &frames)
            .context("The captured display is no longer available.")?;
        native.fullscreen_on_monitor(&screen, monitors[index].0);
    }
    // Tauri/Tao queues visibility requests. Show synchronously so the following
    // set_focus call sees a visible GTK widget and does not silently skip focus.
    native.show_all();
    Ok(())
}

fn capture_monitor_index(frame: Rect, monitors: &[Rect]) -> Option<usize> {
    let x = frame.x + frame.width / 2.0;
    let y = frame.y + frame.height / 2.0;
    monitors.iter().position(|monitor| {
        x >= monitor.x
            && x < monitor.x + monitor.width
            && y >= monitor.y
            && y < monitor.y + monitor.height
    })
}

/// Recording must not race queued Tauri/Tao close/visibility requests. Called
/// on GTK's main thread: unmap the native widget now, then wait for the display
/// server to process our requests before a recorder can capture its first frame.
pub fn hide_window_for_capture(window: &tauri::WebviewWindow) -> Result<()> {
    if !gtk::is_initialized_main_thread() {
        return Err(anyhow!("Capture windows must be hidden on the GTK main thread."));
    }
    let native = window
        .gtk_window()
        .context("Could not access the capture window.")?;
    native.hide();
    native.display().sync();
    if native.is_visible() || native.is_mapped() {
        return Err(anyhow!("The capture window is still visible."));
    }
    Ok(())
}

/// Focus the mapped GTK window synchronously. Tao's queued show/focus pair
/// can try to focus a still-hidden window, leaving Escape in the source app.
pub fn show_recording_countdown(window: &tauri::WebviewWindow) -> Result<()> {
    if !gtk::is_initialized_main_thread() {
        return Err(anyhow!("The countdown must be shown on the GTK main thread."));
    }
    let native = window.gtk_window()?;
    native.set_accept_focus(true);
    native.set_focus_on_map(true);
    native.show_all();
    native.present();
    native.display().sync();
    Ok(())
}

/// Desktop commands may run in an IPC worker as well as on the GTK thread.
/// Never move GTK objects between threads or acquire the main context on a
/// worker: an unowned main context can otherwise run an invocation there.
fn on_gtk_main_thread<T, F>(action: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    if gtk::is_initialized_main_thread() {
        return action();
    }
    if !gtk::is_initialized() {
        return Err(anyhow!("The desktop clipboard is not available."));
    }

    let pending = Arc::new(Mutex::new(Some(action)));
    let scheduled = pending.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    gtk::glib::idle_add_once(move || {
        let action = scheduled.lock().unwrap().take();
        if let Some(action) = action {
            let _ = sender.send(action());
        }
    });
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => {
            // Do not leave an unstarted action queued to replace newer state if
            // the main loop is stopping or cannot service the request.
            pending.lock().unwrap().take();
            Err(anyhow!("The desktop clipboard did not respond."))
        }
    }
}

fn desktop_clipboard() -> Result<gtk::Clipboard> {
    let display = gtk::gdk::Display::default()
        .ok_or_else(|| anyhow!("The desktop clipboard is not available."))?;
    Ok(gtk::Clipboard::for_display(
        &display,
        &gtk::gdk::SELECTION_CLIPBOARD,
    ))
}

pub fn read_image_from_clipboard() -> Result<Vec<u8>> {
    on_gtk_main_thread(|| {
        let image = desktop_clipboard()?.wait_for_image()
            .ok_or_else(|| anyhow!("The clipboard has no image."))?;
        let width = image.width();
        let height = image.height();
        if width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
            i64::from(width) * i64::from(height) * 4 > 128 * 1024 * 1024 {
            return Err(anyhow!("Clipboard image is too large."));
        }
        image.save_to_bufferv("png", &[]).map_err(Into::into)
    })
}

/// The callback and owned PNG remain alive after this function returns, until
/// another application takes clipboard ownership or Kiri exits.
pub fn write_image_to_clipboard(png: &[u8]) -> Result<()> {
    let png = png.to_vec();
    on_gtk_main_thread(move || {
        let clipboard = desktop_clipboard()?;
        let targets = [gtk::TargetEntry::new(
            "image/png",
            gtk::TargetFlags::empty(),
            0,
        )];
        if !clipboard.set_with_data(&targets, move |_, selection, _| {
            selection.set(&selection.target(), 8, &png);
        }) {
            return Err(anyhow!("The image could not be copied to the clipboard."));
        }
        Ok(())
    })
}

pub fn write_text_to_clipboard(text: &str) -> Result<()> {
    let text = text.to_owned();
    on_gtk_main_thread(move || {
        let clipboard = desktop_clipboard()?;
        let targets: Vec<_> = [
            "UTF8_STRING",
            "COMPOUND_TEXT",
            "TEXT",
            "STRING",
            "text/plain;charset=utf-8",
            "text/plain",
        ]
        .into_iter()
        .map(|target| gtk::TargetEntry::new(target, gtk::TargetFlags::empty(), 0))
        .collect();
        if !clipboard.set_with_data(&targets, move |_, selection, _| {
            selection.set_text(&text);
        }) {
            return Err(anyhow!("The text could not be copied to the clipboard."));
        }
        Ok(())
    })
}

fn file_clipboard_data(path: &Path) -> Result<(String, String)> {
    let uri = url::Url::from_file_path(path)
        .map_err(|_| anyhow!("The file could not be copied to the clipboard."))?;
    // Nautilus expects the copy operation as well as a URI; other file managers
    // consume the standard URI-list target. Neither offer reads the media file.
    Ok((format!("{uri}\r\n"), format!("copy\n{uri}")))
}

pub fn write_file_to_clipboard(path: &Path) -> Result<()> {
    let (uri_list, gnome_files) = file_clipboard_data(path)?;
    on_gtk_main_thread(move || {
        let clipboard = desktop_clipboard()?;
        let targets = [
            gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0),
            gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 1),
        ];
        if !clipboard.set_with_data(&targets, move |_, selection, target| {
            let data = if target == 1 { &gnome_files } else { &uri_list };
            selection.set(&selection.target(), 8, data.as_bytes());
        }) {
            return Err(anyhow!("The file could not be copied to the clipboard."));
        }
        Ok(())
    })
}

/// Ask the desktop file manager to select the file, then fall back to opening
/// its parent. All work stays local; no shell command contains the file path.
pub fn reveal_path(path: &Path) {
    let path = path.to_owned();
    if let Err(error) = std::thread::Builder::new()
        .name("kiri-reveal-file".into())
        .spawn(move || {
            if let Err(error) = reveal_path_inner(&path) {
                log::warn!("Could not reveal the capture: {error}");
            }
        })
    {
        log::warn!("Could not start the file manager request: {error}");
    }
}

fn reveal_path_inner(path: &Path) -> Result<()> {
    let uri = url::Url::from_file_path(path)
        .map_err(|_| anyhow!("The capture path is not an absolute local path."))?;
    if !path.is_dir() {
        if let Ok(connection) =
            gtk::gio::bus_get_sync(gtk::gio::BusType::Session, None::<&gtk::gio::Cancellable>)
        {
            let parameters = (vec![uri.as_str()], "").to_variant();
            if connection
                .call_sync(
                    Some("org.freedesktop.FileManager1"),
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1",
                    "ShowItems",
                    Some(&parameters),
                    None,
                    gtk::gio::DBusCallFlags::NONE,
                    3_000,
                    None::<&gtk::gio::Cancellable>,
                )
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    let directory = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let directory_uri = url::Url::from_file_path(directory)
        .map_err(|_| anyhow!("The capture folder could not be opened."))?;
    gtk::gio::AppInfo::launch_default_for_uri(
        directory_uri.as_str(),
        None::<&gtk::gio::AppLaunchContext>,
    )
    .context("The capture folder could not be opened.")
}

fn x11_property_value(
    connection: &x11rb::rust_connection::RustConnection,
    window: u32,
    property: &[u8],
    value_type: AtomEnum,
) -> Result<Option<u32>> {
    let atom = connection.intern_atom(false, property)?.reply()?.atom;
    let reply = connection
        .get_property(false, window, atom, value_type, 0, 1)?
        .reply()?;
    Ok(reply.value32().and_then(|mut values| values.next()))
}

/// Remember the exact X11 window, not another window belonging to its process.
/// Wayland deliberately provides no equivalent global foreground-window API.
pub fn frontmost_application() -> Option<(u32, Option<String>)> {
    *CAPTURE_FOCUS_TARGET.lock().unwrap() = None;
    if is_wayland_session() {
        return None;
    }
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let window =
        x11_property_value(&connection, root, b"_NET_ACTIVE_WINDOW", AtomEnum::WINDOW).ok()??;
    let pid =
        x11_property_value(&connection, window, b"_NET_WM_PID", AtomEnum::CARDINAL).ok()??;
    if window == 0 || pid == 0 {
        return None;
    }
    let name = x11rb::properties::WmClass::get(&connection, window)
        .ok()
        .and_then(|cookie| cookie.reply().ok().flatten())
        .and_then(|class| String::from_utf8(class.class().to_vec()).ok())
        .filter(|name| !name.is_empty());
    if pid != std::process::id() {
        *CAPTURE_FOCUS_TARGET.lock().unwrap() = Some(X11FocusTarget { window, pid });
    }
    // Keep Kiri's PID in the result: capture uses it to restore its own library
    // focus when capture was started from that window.
    Some((pid, name))
}

pub fn activate_application(pid: u32) {
    let target = {
        let mut saved = CAPTURE_FOCUS_TARGET.lock().unwrap();
        if saved.is_some_and(|target| target.pid == pid) {
            saved.take()
        } else {
            None
        }
    };
    if let Some(target) = target.filter(|_| !is_wayland_session()) {
        if let Err(error) = activate_x11_window(target) {
            log::debug!("The window manager could not restore capture focus: {error}");
        }
    }
}

fn activate_x11_window(target: X11FocusTarget) -> Result<()> {
    let (connection, screen) = x11rb::connect(None)?;
    // X11 identifiers may be reused after a client exits. Do not focus a new
    // client just because it happens to own the same window identifier.
    if x11_property_value(
        &connection,
        target.window,
        b"_NET_WM_PID",
        AtomEnum::CARDINAL,
    )? != Some(target.pid)
    {
        return Ok(());
    }
    let root = connection.setup().roots[screen].root;
    let atom = connection
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")?
        .reply()?
        .atom;
    let event = ClientMessageEvent::new(32, target.window, atom, [1, 0, 0, 0, 0]);
    connection
        .send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )?
        .check()?;
    connection.flush()?;
    Ok(())
}

pub fn show_window_without_activation(app: &tauri::AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_owned();
    if let Err(error) = on_gtk_main_thread(move || {
        if let Some(window) = app.get_webview_window(&label) {
            let native = window.gtk_window()?;
            native.set_focus_on_map(false);
            // Complete mapping before the subsequent external-app activation.
            // A queued show could otherwise win focus after that request.
            native.show_all();
            native.display().sync();
        }
        Ok(())
    }) {
        log::warn!("Could not show capture feedback: {error}");
    }
}

pub fn mic_supported() -> bool {
    crate::linux_audio::supported()
}

pub fn request_microphone_access() -> Result<MicrophoneAccess> {
    // Linux grants are enforced by the sound service when the explicitly
    // requested check/recording opens its source. This does not change grants.
    Ok(MicrophoneAccess::Authorized)
}

pub fn set_window_click_through(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.set_ignore_cursor_events(true) {
            log::warn!("Could not make the capture feedback ignore pointer input: {error}");
        }
    }
}

pub fn set_window_capture_excluded(_app: &tauri::AppHandle, _label: &str, _excluded: bool) {
    // The ScreenCast portal cannot exclude Kiri windows. Recording must not be
    // advertised as supported until the capture flow can keep its UI out.
}

pub fn start_click_monitor(
    _callback: Arc<dyn Fn(f64, f64) + Send + Sync>,
) -> Result<Box<dyn ClickMonitorHandle + Send>> {
    Err(anyhow!(
        "Global click highlights are not available on this Linux session yet."
    ))
}

#[cfg(test)]
mod tests {
    use super::{capture_monitor_index, file_clipboard_data};
    use crate::core::geometry::Rect;
    use std::path::Path;

    #[test]
    fn capture_fullscreen_targets_the_captured_monitor_including_negative_origins() {
        let monitors = [
            Rect::new(0.0, 0.0, 1920.0, 1080.0),
            Rect::new(-1280.0, 100.0, 1280.0, 800.0),
            Rect::new(1920.0, -900.0, 1440.0, 900.0),
        ];
        for (index, frame) in monitors.iter().enumerate() {
            assert_eq!(capture_monitor_index(*frame, &monitors), Some(index));
        }
        assert_eq!(capture_monitor_index(monitors[0], &[]), None);
        assert_eq!(
            capture_monitor_index(Rect::new(4000.0, 0.0, 800.0, 600.0), &monitors),
            None
        );
    }

    #[test]
    fn file_clipboard_offers_escaped_uris_and_a_gnome_copy_operation() {
        let (uri_list, gnome) =
            file_clipboard_data(Path::new("/tmp/Kiri captures/clip #1\n.mp4")).unwrap();
        assert_eq!(
            uri_list,
            "file:///tmp/Kiri%20captures/clip%20%231%0A.mp4\r\n"
        );
        assert_eq!(
            gnome,
            "copy\nfile:///tmp/Kiri%20captures/clip%20%231%0A.mp4"
        );
    }

    #[test]
    fn file_clipboard_rejects_relative_paths() {
        assert!(file_clipboard_data(Path::new("clip.mp4")).is_err());
    }
}
