//! Native action shortcut preferences and transactional replacement.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutAction {
    Capture,
    Record,
    Ocr,
    Library,
    RecordingPauseResume,
    RecordingStop,
}

impl ShortcutAction {
    pub const ALL: [Self; 6] = [
        Self::Capture,
        Self::Record,
        Self::Ocr,
        Self::Library,
        Self::RecordingPauseResume,
        Self::RecordingStop,
    ];
    fn index(self) -> usize {
        match self {
            Self::Capture => 0,
            Self::Record => 1,
            Self::Ocr => 2,
            Self::Library => 3,
            Self::RecordingPauseResume => 4,
            Self::RecordingStop => 5,
        }
    }
    pub fn scope(self) -> ShortcutScope {
        match self {
            Self::RecordingPauseResume | Self::RecordingStop => ShortcutScope::Recording,
            _ => ShortcutScope::Global,
        }
    }
    pub fn default_binding(self) -> Shortcut {
        let primary = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        let key = match self {
            Self::Capture => Code::KeyA,
            Self::Record => Code::KeyR,
            Self::Ocr => Code::KeyO,
            Self::Library => Code::KeyL,
            Self::RecordingPauseResume => Code::KeyP,
            Self::RecordingStop => Code::KeyS,
        };
        let modifiers = if self == Self::Capture {
            primary | Modifiers::SHIFT
        } else {
            primary | Modifiers::SHIFT | Modifiers::ALT
        };
        Shortcut::new(Some(modifiers), key)
    }
    pub fn command(self) -> &'static str {
        match self {
            Self::Capture => "kiri --capture",
            Self::Record => "kiri --record",
            Self::Ocr => "kiri --ocr",
            Self::Library => "kiri --library",
            Self::RecordingPauseResume => "kiri --toggle-recording-pause",
            Self::RecordingStop => "kiri --stop-recording",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutScope {
    Global,
    Recording,
}

#[derive(Clone)]
pub struct Bindings([Option<Shortcut>; 6]);
impl Default for Bindings {
    fn default() -> Self {
        Self(ShortcutAction::ALL.map(|action| Some(action.default_binding())))
    }
}
impl Bindings {
    fn get(&self, action: ShortcutAction) -> Option<Shortcut> {
        self.0[action.index()]
    }
    fn with(&self, action: ShortcutAction, candidate: Option<Shortcut>) -> Result<Self, String> {
        if candidate.is_some()
            && ShortcutAction::ALL
                .into_iter()
                .any(|other| other != action && self.get(other) == candidate)
        {
            return Err("This shortcut is already assigned to another action.".into());
        }
        let mut bindings = self.clone();
        bindings.0[action.index()] = candidate;
        Ok(bindings)
    }
}

pub struct ShortcutBindings {
    current: Mutex<Bindings>,
    // Zero means unassigned; widen/offset u32 IDs so native ID zero is valid.
    ids: [AtomicU64; 6],
    pressed_ids: [AtomicU64; 6],
    editing: AtomicBool,
    library_focused: AtomicBool,
    recording_active: AtomicBool,
    recording_epoch: AtomicU64,
}
impl ShortcutBindings {
    pub fn new(bindings: Bindings) -> Self {
        Self {
            ids: std::array::from_fn(|i| AtomicU64::new(shortcut_id(bindings.0[i]))),
            pressed_ids: std::array::from_fn(|_| AtomicU64::new(0)),
            current: Mutex::new(bindings),
            editing: AtomicBool::new(false),
            library_focused: AtomicBool::new(false),
            recording_active: AtomicBool::new(false),
            recording_epoch: AtomicU64::new(0),
        }
    }
    // The plugin holds its registration-map lock during callbacks. Never acquire
    // the replacement mutex or query native registrations in that callback.
    pub fn action_for(&self, shortcut: &Shortcut) -> Option<ShortcutAction> {
        let id = shortcut_id(Some(*shortcut));
        ShortcutAction::ALL
            .into_iter()
            .find(|action| self.ids[action.index()].load(Ordering::Acquire) == id)
    }
    pub fn press(&self, shortcut: &Shortcut) -> Option<ShortcutAction> {
        let id = shortcut_id(Some(*shortcut));
        // Saving or cancelling the editor while this combination is held must
        // not turn a repeat into a real action.
        if self
            .pressed_ids
            .iter()
            .any(|pressed| pressed.load(Ordering::Acquire) == id)
        {
            return None;
        }
        let action = self.action_for(shortcut)?;
        if !self.action_is_active(action) {
            return None;
        }
        self.pressed_ids[action.index()].store(id, Ordering::Release);
        Some(action)
    }
    pub fn release(&self, shortcut: &Shortcut) {
        let id = shortcut_id(Some(*shortcut));
        for pressed in &self.pressed_ids {
            let _ = pressed.compare_exchange(id, 0, Ordering::AcqRel, Ordering::Acquire);
        }
    }
    pub fn set_editing(&self, editing: bool) {
        self.editing.store(editing, Ordering::Release);
    }
    pub fn set_library_focused(&self, focused: bool) {
        self.library_focused.store(focused, Ordering::Release);
        if !focused {
            self.set_editing(false);
        }
    }
    pub fn is_editing(&self) -> bool {
        self.editing.load(Ordering::Acquire) && self.library_focused.load(Ordering::Acquire)
    }
    fn action_is_active(&self, action: ShortcutAction) -> bool {
        action.scope() == ShortcutScope::Global || self.recording_active.load(Ordering::Acquire)
    }
    pub fn recording_epoch(&self) -> u64 {
        self.recording_epoch.load(Ordering::Acquire)
    }
    fn set_recording_active(&self, active: bool) -> bool {
        if self.recording_active.swap(active, Ordering::AcqRel) == active {
            return false;
        }
        self.recording_epoch.fetch_add(1, Ordering::AcqRel);
        true
    }
}
fn shortcut_id(shortcut: Option<Shortcut>) -> u64 {
    shortcut.map_or(0, |shortcut| u64::from(shortcut.id()) + 1)
}
pub fn default_binding() -> Shortcut {
    ShortcutAction::Capture.default_binding()
}

pub fn parse(value: &str) -> Result<Shortcut, String> {
    // The native library accepts one supported key, with optional modifiers.
    // Keep its syntax and key support rather than restricting users to letters
    // and digits. OS registration remains the authority for availability.
    value
        .parse()
        .map_err(|_| "This key is not supported as a shortcut.".to_string())
}
pub fn current(app: &AppHandle, action: ShortcutAction) -> Option<Shortcut> {
    app.state::<ShortcutBindings>()
        .current
        .lock()
        .unwrap()
        .get(action)
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    version: u8,
    bindings: BTreeMap<ShortcutAction, Option<String>>,
}
fn encode(bindings: &Bindings) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&Preferences {
        version: 1,
        bindings: ShortcutAction::ALL
            .into_iter()
            .map(|action| (action, bindings.get(action).map(|key| key.to_string())))
            .collect(),
    })
    .map_err(|_| "Could not save the shortcuts.".into())
}
fn decode(bytes: &[u8]) -> Result<Bindings, String> {
    let preferences: Preferences = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if preferences.version != 1 {
        return Err("Unsupported shortcut settings version.".into());
    }
    let mut bindings = Bindings([None; 6]);
    // Saved custom choices take priority over newly introduced default actions.
    for action in ShortcutAction::ALL {
        if let Some(value) = preferences.bindings.get(&action) {
            bindings = bindings.with(action, value.as_deref().map(parse).transpose()?)?;
        }
    }
    for action in ShortcutAction::ALL {
        if !preferences.bindings.contains_key(&action) {
            if let Ok(updated) = bindings.with(action, Some(action.default_binding())) {
                bindings = updated;
            }
        }
    }
    Ok(bindings)
}
fn load_from_dir(dir: &Path) -> Bindings {
    match std::fs::read(dir.join("shortcuts.json")) {
        Ok(bytes) => match decode(&bytes) {
            Ok(bindings) => return bindings,
            Err(error) => log::warn!("Could not load action shortcuts: {error}"),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("Could not read action shortcuts: {error}"),
    }
    let capture = std::fs::read_to_string(dir.join("capture-shortcut.txt"))
        .ok()
        .and_then(|value| parse(value.trim()).ok())
        .unwrap_or_else(default_binding);
    let mut bindings = Bindings([None; 6]);
    bindings.0[ShortcutAction::Capture.index()] = Some(capture);
    for action in ShortcutAction::ALL.into_iter().skip(1) {
        if let Ok(updated) = bindings.with(action, Some(action.default_binding())) {
            bindings = updated;
        }
    }
    bindings
}
pub fn load(app: &AppHandle) -> Bindings {
    app.path()
        .app_config_dir()
        .map(|dir| load_from_dir(&dir))
        .unwrap_or_default()
}

pub fn label(shortcut: Shortcut) -> String {
    if shortcut == default_binding() {
        return crate::core::shortcut::KIRI_CAPTURE.display_label();
    }
    label_for_platform(shortcut, cfg!(target_os = "macos"))
}

fn label_for_platform(shortcut: Shortcut, mac: bool) -> String {
    let mut tokens = Vec::new();
    for (modifier, symbol, name) in [
        (Modifiers::SHIFT, "⇧", "Shift"),
        (Modifiers::CONTROL, "⌃", "Ctrl"),
        (Modifiers::ALT, "⌥", "Alt"),
        (Modifiers::SUPER, "⌘", "Win"),
    ] {
        if shortcut.mods.contains(modifier) {
            tokens.push(if mac { symbol } else { name }.to_string());
        }
    }
    tokens.push(key_label(shortcut.key, mac));
    tokens.join(if mac { "" } else { "+" })
}

fn key_label(key: Code, mac: bool) -> String {
    use Code::*;
    // These are keycap names, like Ctrl/Shift above, not serialized key codes.
    // In particular, retain the distinction between the number row and keypad.
    match key {
        Backquote => "`",
        Backslash => "\\",
        BracketLeft => "[",
        BracketRight => "]",
        Comma => ",",
        Equal => "=",
        Minus => "-",
        Period => ".",
        Quote => "'",
        Semicolon => ";",
        Slash => "/",
        Backspace if mac => "⌫",
        Delete if mac => "⌦",
        Enter if mac => "↩",
        Tab if mac => "⇥",
        Escape => "Esc",
        CapsLock => "Caps Lock",
        PageDown => "Page Down",
        PageUp => "Page Up",
        PrintScreen => "Print Screen",
        ScrollLock => "Scroll Lock",
        NumLock => "Num Lock",
        ArrowDown => "↓",
        ArrowLeft => "←",
        ArrowRight => "→",
        ArrowUp => "↑",
        NumpadAdd => "Num +",
        NumpadDecimal => "Num .",
        NumpadDivide => "Num /",
        NumpadEnter => "Num Enter",
        NumpadEqual => "Num =",
        NumpadMultiply => "Num *",
        NumpadSubtract => "Num -",
        AudioVolumeDown => "Volume Down",
        AudioVolumeUp => "Volume Up",
        AudioVolumeMute => "Mute",
        MediaPlay => "Media Play",
        MediaPause => "Media Pause",
        MediaPlayPause => "Play/Pause",
        MediaStop => "Media Stop",
        MediaTrackNext => "Next Track",
        MediaTrackPrevious => "Previous Track",
        _ => {
            let name = key.to_string();
            if let Some(digit) = name.strip_prefix("Numpad") {
                return format!("Num {digit}");
            }
            return name
                .strip_prefix("Key")
                .or_else(|| name.strip_prefix("Digit"))
                .unwrap_or(&name)
                .to_string();
        }
    }
    .into()
}
pub fn system_managed() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::capture::linux::is_wayland()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}
pub fn is_registered(app: &AppHandle, action: ShortcutAction) -> bool {
    !system_managed()
        && current(app, action).is_some_and(|key| app.global_shortcut().is_registered(key))
}
const MEDIA_KEY_ACCESS_ERROR: &str =
    "Media key shortcuts require Accessibility access. Enable it for Kiri in System Settings.";
const UNSUPPORTED_KEY_ERROR: &str = "This key is not supported as a shortcut.";

fn registration_error(error: &str) -> String {
    if error == MEDIA_KEY_ACCESS_ERROR || error == UNSUPPORTED_KEY_ERROR {
        return error.into();
    }
    "This shortcut is unavailable. Choose another combination.".into()
}

pub fn retry(app: &AppHandle, action: ShortcutAction) -> Result<(), String> {
    if system_managed() {
        return Ok(());
    }
    let state = app.state::<ShortcutBindings>();
    let active = state.current.lock().unwrap();
    if !state.action_is_active(action) {
        return Ok(());
    }
    if let Some(key) = active.get(action) {
        let manager = app.global_shortcut();
        if !manager.is_registered(key) {
            NativeRegistrar(app).register(key).map_err(|error| {
                log::warn!("Could not register {action:?} shortcut: {error}");
                registration_error(&error)
            })?;
        }
    }
    Ok(())
}
pub fn register_all(app: &AppHandle) {
    for action in ShortcutAction::ALL {
        if let Err(error) = retry(app, action) {
            log::warn!("[shortcut] {action:?} registration failed: {error}");
        }
    }
}

/// Called while the recording state may be locked. Publish the desired scope
/// immediately, then leave both the recording lock and the native shortcut
/// callback before querying or changing native registrations.
pub fn update_recording_scope(app: &AppHandle, active: bool) {
    let Some(state) = app.try_state::<ShortcutBindings>() else {
        return;
    };
    if !state.set_recording_active(active) {
        return;
    }
    if system_managed() {
        return;
    }
    let app = app.clone();
    std::mem::drop(tauri::async_runtime::spawn_blocking(move || {
        // Native registration synchronously dispatches to the main thread.
        // Acquire the preference lock there, otherwise a simultaneous settings
        // IPC on main could wait for this lock while this worker waits for main.
        let target = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let failed = reconcile_recording_scope(&target.state::<ShortcutBindings>(), &NativeRegistrar(&target));
            let _ = target.emit("shortcut-settings-changed", settings(&target));
            if failed {
                crate::state::emit_error(&target,
                    "A recording shortcut is unavailable. Open Shortcuts settings to choose another combination.".into(), None);
            }
        }) {
            log::warn!("[shortcut] could not schedule recording registrations: {error}");
        }
    }));
}

fn reconcile_recording_scope(state: &ShortcutBindings, registrar: &impl Registrar) -> bool {
    // The same mutex serializes preference replacement and lifecycle changes.
    // Read the newest desired state inside it: a queued start must not register
    // shortcuts after a stop, nor unregister those of a replacement session.
    let bindings = state.current.lock().unwrap();
    let mut failed = false;
    loop {
        let active = state.recording_active.load(Ordering::Acquire);
        for action in ShortcutAction::ALL
            .into_iter()
            .filter(|action| action.scope() == ShortcutScope::Recording)
        {
            let Some(key) = bindings.get(action) else {
                continue;
            };
            let registered = registrar.is_registered(key);
            if active && !registered {
                if let Err(error) = registrar.register(key) {
                    log::warn!("[shortcut] {action:?} registration failed: {error}");
                    failed = true;
                }
            } else if !active && registered {
                if let Err(error) = registrar.unregister(key) {
                    log::warn!("[shortcut] {action:?} release failed: {error}");
                    failed = true;
                } else {
                    state.release(&key);
                }
            }
        }
        if active == state.recording_active.load(Ordering::Acquire) {
            return failed;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationStatus {
    Enabled,
    Occupied,
    Disabled,
    SystemManaged,
    Inactive,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettingDto {
    pub action: ShortcutAction,
    pub scope: ShortcutScope,
    pub label: Option<String>,
    pub default_label: String,
    pub status: RegistrationStatus,
    pub is_default: bool,
}
pub fn settings(app: &AppHandle) -> Vec<ShortcutSettingDto> {
    let state = app.state::<ShortcutBindings>();
    let bindings = state.current.lock().unwrap();
    ShortcutAction::ALL
        .into_iter()
        .map(|action| {
            let shortcut = bindings.get(action);
            let system = system_managed();
            ShortcutSettingDto {
                action,
                scope: action.scope(),
                label: if system {
                    Some(action.command().into())
                } else {
                    shortcut.map(label)
                },
                default_label: label(action.default_binding()),
                status: if system {
                    RegistrationStatus::SystemManaged
                } else if let Some(key) = shortcut {
                    if !state.action_is_active(action) {
                        RegistrationStatus::Inactive
                    } else if app.global_shortcut().is_registered(key) {
                        RegistrationStatus::Enabled
                    } else {
                        RegistrationStatus::Occupied
                    }
                } else {
                    RegistrationStatus::Disabled
                },
                is_default: shortcut == Some(action.default_binding()),
            }
        })
        .collect()
}

// Injectable transaction: unit tests never touch a user's native registrations.
trait Registrar {
    fn validate(&self, shortcut: Shortcut) -> Result<(), String>;
    fn is_registered(&self, shortcut: Shortcut) -> bool;
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}
struct NativeRegistrar<'a>(&'a AppHandle);
impl Registrar for NativeRegistrar<'_> {
    fn validate(&self, key: Shortcut) -> Result<(), String> {
        if !key.is_supported_on_current_platform() {
            return Err(UNSUPPORTED_KEY_ERROR.into());
        }
        #[cfg(target_os = "macos")]
        if matches!(
            key.key,
            Code::MediaPlayPause
                | Code::MediaTrackNext
                | Code::MediaTrackPrevious
                | Code::MediaFastForward
                | Code::MediaRewind
        ) && !objc2_core_graphics::CGPreflightPostEventAccess()
        {
            // The media path uses an active event tap. Check access without
            // requesting it; ordinary Carbon shortcuts need no such permission.
            return Err(MEDIA_KEY_ACCESS_ERROR.into());
        }
        Ok(())
    }
    fn is_registered(&self, key: Shortcut) -> bool {
        self.0.global_shortcut().is_registered(key)
    }
    fn register(&self, key: Shortcut) -> Result<(), String> {
        self.validate(key)?;
        self.0
            .global_shortcut()
            .register(key)
            .map_err(|e| e.to_string())
    }
    fn unregister(&self, key: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(key)
            .map_err(|e| e.to_string())
    }
}
fn replace_transaction(
    registrar: &impl Registrar,
    previous: Option<Shortcut>,
    candidate: Option<Shortcut>,
    scope_active: bool,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    // Even dormant preferences must have a native mapping and any required
    // access before replacing a saved key. Validation never owns an OS key.
    if let Some(key) = candidate {
        registrar
            .validate(key)
            .map_err(|error| registration_error(&error))?;
    }
    let candidate = candidate.filter(|_| scope_active);
    let candidate_is_new = candidate.is_some_and(|key| !registrar.is_registered(key));
    if let Some(key) = candidate.filter(|_| candidate_is_new) {
        registrar.register(key).map_err(|error| {
            log::warn!("Could not register shortcut replacement: {error}");
            registration_error(&error)
        })?;
    }
    let release_previous =
        previous.filter(|key| Some(*key) != candidate && registrar.is_registered(*key));
    if let Some(key) = release_previous {
        if let Err(error) = registrar.unregister(key) {
            if let Some(key) = candidate.filter(|_| candidate_is_new) {
                let _ = registrar.unregister(key);
            }
            log::warn!("Could not release previous shortcut: {error}");
            return Err("Could not change the shortcut.".into());
        }
    }
    if let Err(error) = persist() {
        if let Some(key) = candidate.filter(|_| candidate_is_new) {
            let _ = registrar.unregister(key);
        }
        if let Some(key) = release_previous {
            if let Err(restore_error) = registrar.register(key) {
                log::warn!("Could not restore shortcut after save failure: {restore_error}");
            }
        }
        return Err(error);
    }
    Ok(())
}
pub fn replace(app: &AppHandle, action: ShortcutAction, value: Option<&str>) -> Result<(), String> {
    if system_managed() {
        return Err("Set this shortcut in your desktop settings.".into());
    }
    let candidate = value.map(parse).transpose()?;
    let state = app.state::<ShortcutBindings>();
    let mut active = state.current.lock().unwrap();
    let updated = active.with(action, candidate)?;
    let previous = active.get(action);
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not save the shortcuts.".to_string())?;
    let bytes = encode(&updated)?;
    // Stage the complete preference before touching registrations. Persist is an
    // atomic destination replacement on macOS, Linux, and Windows.
    let staged = (|| -> std::io::Result<tempfile::NamedTempFile> {
        std::fs::create_dir_all(&dir)?;
        let mut file = tempfile::NamedTempFile::new_in(&dir)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        Ok(file)
    })()
    .map_err(|_| "Could not save the shortcuts.".to_string())?;
    // Dormant recording bindings are preferences, not idle OS registrations.
    // Native conflicts can only be known when the recording scope activates.
    replace_transaction(
        &NativeRegistrar(app),
        previous,
        candidate,
        state.action_is_active(action),
        || {
            staged
                .persist(dir.join("shortcuts.json"))
                .map(|_| ())
                .map_err(|_| "Could not save the shortcuts.".to_string())
        },
    )?;
    *active = updated;
    state.ids[action.index()].store(shortcut_id(candidate), Ordering::Release);
    if previous != candidate {
        if let Some(previous) = previous {
            // The plugin stops forwarding Released for unregistered keys. Do
            // not leave a stale pressed ID when this binding is removed.
            state.release(&previous);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashSet};
    #[test]
    fn rejects_modifier_only_unknown_and_malformed_bindings() {
        for value in [
            "",
            "Control",
            "Shift+Alt",
            "Super",
            "ControlLeft",
            "ShiftRight",
            "Alt+ControlRight",
            "Fn",
            "Fn+KeyA",
            "garbage",
            "Unidentified",
            "F25",
            "Control++KeyA",
            "Control+KeyA+KeyB",
            "Control+KeyA+Shift",
        ] {
            assert!(parse(value).is_err(), "{value}");
        }
    }
    #[test]
    fn accepts_library_supported_keys_with_optional_modifiers_and_roundtrips() {
        for value in [
            "Control+Shift+KeyA",
            "Alt+Digit7",
            "Super+KeyK",
            "KeyA",
            "Shift+KeyA",
            "Digit7",
            "F1",
            "Shift+F12",
            "F24",
            "Space",
            "Control+Space",
            "Enter",
            "Control+Enter",
            "ArrowLeft",
            "Alt+ArrowUp",
            "PageDown",
            "Delete",
            "Escape",
            "Tab",
            "Control+Tab",
            "CapsLock",
            "Pause",
            "PrintScreen",
            "Backquote",
            "Backslash",
            "BracketLeft",
            "BracketRight",
            "Comma",
            "Equal",
            "Minus",
            "Period",
            "Quote",
            "Semicolon",
            "Slash",
            "Shift+Slash",
            "Numpad0",
            "Numpad9",
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            "NumpadEnter",
            "NumpadEqual",
            "AudioVolumeDown",
            "AudioVolumeUp",
            "AudioVolumeMute",
            "MediaPlayPause",
            "MediaTrackNext",
            "MediaTrackPrevious",
        ] {
            let shortcut = parse(value).unwrap();
            assert_eq!(parse(&shortcut.to_string()).unwrap(), shortcut, "{value}");
        }
        assert_eq!(
            label(default_binding()),
            crate::core::shortcut::KIRI_CAPTURE.display_label()
        );
    }
    #[test]
    fn special_key_labels_are_readable_on_both_platform_styles() {
        for (key, mac, other) in [
            ("Space", "Space", "Space"),
            ("Enter", "↩", "Enter"),
            ("Tab", "⇥", "Tab"),
            ("Backspace", "⌫", "Backspace"),
            ("Delete", "⌦", "Delete"),
            ("Escape", "Esc", "Esc"),
            ("ArrowLeft", "←", "←"),
            ("ArrowRight", "→", "→"),
            ("ArrowUp", "↑", "↑"),
            ("ArrowDown", "↓", "↓"),
            ("PageDown", "Page Down", "Page Down"),
            ("PageUp", "Page Up", "Page Up"),
            ("PrintScreen", "Print Screen", "Print Screen"),
            ("ScrollLock", "Scroll Lock", "Scroll Lock"),
            ("CapsLock", "Caps Lock", "Caps Lock"),
            ("NumLock", "Num Lock", "Num Lock"),
            ("Numpad7", "Num 7", "Num 7"),
            ("NumpadEnter", "Num Enter", "Num Enter"),
            ("NumpadAdd", "Num +", "Num +"),
            ("NumpadEqual", "Num =", "Num ="),
            ("NumpadDecimal", "Num .", "Num ."),
            ("BracketLeft", "[", "["),
            ("Backslash", "\\", "\\"),
            ("AudioVolumeUp", "Volume Up", "Volume Up"),
            ("MediaPlayPause", "Play/Pause", "Play/Pause"),
            ("MediaTrackPrevious", "Previous Track", "Previous Track"),
        ] {
            let key = parse(key).unwrap();
            assert_eq!(label_for_platform(key, true), mac);
            assert_eq!(label_for_platform(key, false), other);
        }
        assert_eq!(
            label_for_platform(parse("Super+Space").unwrap(), true),
            "⌘Space"
        );
        assert_eq!(
            label_for_platform(parse("Shift+Super+Enter").unwrap(), true),
            "⇧⌘↩"
        );
        assert_eq!(
            label_for_platform(parse("Control+PageDown").unwrap(), false),
            "Ctrl+Page Down"
        );
        assert_eq!(
            label_for_platform(parse("Alt+Numpad7").unwrap(), false),
            "Alt+Num 7"
        );
        assert_eq!(
            label_for_platform(parse("Control+Shift+F12").unwrap(), false),
            "Shift+Ctrl+F12"
        );
    }
    #[test]
    fn expanded_keys_persist_with_their_canonical_identity_and_detect_duplicates() {
        let bindings = [
            "Space",
            "Shift+Slash",
            "Numpad7",
            "F13",
            "ArrowLeft",
            "Control+Enter",
        ]
        .into_iter()
        .zip(ShortcutAction::ALL)
        .fold(Bindings::default(), |bindings, (key, action)| {
            bindings.with(action, Some(parse(key).unwrap())).unwrap()
        });
        let directory = tempfile::tempdir().unwrap();
        let encoded = encode(&bindings).unwrap();
        std::fs::write(directory.path().join("shortcuts.json"), &encoded).unwrap();
        assert_eq!(decode(&encoded).unwrap().0, bindings.0);
        assert_eq!(load_from_dir(directory.path()).0, bindings.0);
        assert!(bindings
            .with(ShortcutAction::Ocr, Some(parse("Space").unwrap()))
            .is_err());
        assert!(
            bindings
                .with(ShortcutAction::Ocr, Some(parse("Digit7").unwrap()))
                .is_ok(),
            "keypad and number-row keys keep distinct identities"
        );
    }
    #[test]
    fn distinct_defaults_identify_each_action_without_locking() {
        let state = ShortcutBindings::new(Bindings::default());
        let _held = state.current.lock().unwrap();
        for action in ShortcutAction::ALL {
            assert_eq!(state.action_for(&action.default_binding()), Some(action));
        }
        assert_eq!(state.action_for(&parse("Alt+Digit7").unwrap()), None);
        assert!(!ShortcutAction::Capture
            .default_binding()
            .mods
            .contains(Modifiers::ALT));
        for action in [
            ShortcutAction::Record,
            ShortcutAction::Ocr,
            ShortcutAction::Library,
        ] {
            assert!(action.default_binding().mods.contains(Modifiers::ALT));
        }
    }
    #[test]
    fn shortcut_recording_requires_library_focus_and_blur_clears_it() {
        let state = ShortcutBindings::new(Bindings::default());
        state.set_editing(true);
        assert!(!state.is_editing());
        state.set_library_focused(true);
        assert!(state.is_editing());
        state.set_library_focused(false);
        assert!(!state.is_editing());
        state.set_library_focused(true);
        assert!(!state.is_editing());
    }
    #[test]
    fn accepting_recorded_key_needs_release_before_dispatching_again() {
        let state = ShortcutBindings::new(Bindings::default());
        let key = ShortcutAction::Record.default_binding();
        state.set_library_focused(true);
        state.set_editing(true);
        assert_eq!(state.press(&key), Some(ShortcutAction::Record));
        state.set_editing(false);
        assert_eq!(state.press(&key), None);
        state.release(&key);
        assert_eq!(state.press(&key), Some(ShortcutAction::Record));
    }
    #[test]
    fn release_clears_old_native_id_after_binding_replacement() {
        let state = ShortcutBindings::new(Bindings::default());
        let key = ShortcutAction::Capture.default_binding();
        assert_eq!(state.press(&key), Some(ShortcutAction::Capture));
        state.ids[ShortcutAction::Capture.index()].store(0, Ordering::Release);
        state.ids[ShortcutAction::Record.index()].store(shortcut_id(Some(key)), Ordering::Release);
        assert_eq!(state.press(&key), None);
        state.release(&key);
        assert_eq!(state.press(&key), Some(ShortcutAction::Record));
    }
    #[test]
    fn actions_and_statuses_serialize_for_settings() {
        assert_eq!(
            serde_json::to_value(ShortcutAction::ALL).unwrap(),
            serde_json::json!([
                "capture",
                "record",
                "ocr",
                "library",
                "recordingPauseResume",
                "recordingStop"
            ])
        );
        assert_eq!(
            serde_json::to_value(RegistrationStatus::SystemManaged).unwrap(),
            "systemManaged"
        );
        assert_eq!(
            serde_json::to_value(RegistrationStatus::Inactive).unwrap(),
            "inactive"
        );
        assert_eq!(
            serde_json::to_value(ShortcutAction::RecordingStop.scope()).unwrap(),
            "recording"
        );
    }
    #[test]
    fn duplicate_rejected_but_same_action_and_unassigned_allowed() {
        let bindings = Bindings::default();
        let capture = Some(default_binding());
        assert!(bindings.with(ShortcutAction::Record, capture).is_err());
        assert!(bindings.with(ShortcutAction::Capture, capture).is_ok());
        let disabled = bindings.with(ShortcutAction::Capture, None).unwrap();
        assert!(disabled.with(ShortcutAction::Record, capture).is_ok());
        assert_eq!(
            ShortcutBindings::new(disabled).action_for(&default_binding()),
            None
        );
    }
    #[test]
    fn legacy_capture_wins_over_new_conflicting_default() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = ShortcutAction::Record.default_binding();
        std::fs::write(
            directory.path().join("capture-shortcut.txt"),
            legacy.to_string(),
        )
        .unwrap();
        let loaded = load_from_dir(directory.path());
        assert_eq!(loaded.get(ShortcutAction::Capture), Some(legacy));
        assert_eq!(loaded.get(ShortcutAction::Record), None);
        assert_eq!(
            loaded.get(ShortcutAction::Ocr),
            Some(ShortcutAction::Ocr.default_binding())
        );
    }
    #[test]
    fn persisted_disabled_and_custom_bindings_override_legacy() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("capture-shortcut.txt"), "Alt+KeyB").unwrap();
        let updated = Bindings::default()
            .with(ShortcutAction::Capture, None)
            .unwrap()
            .with(ShortcutAction::Record, Some(parse("Alt+Digit7").unwrap()))
            .unwrap();
        std::fs::write(
            directory.path().join("shortcuts.json"),
            encode(&updated).unwrap(),
        )
        .unwrap();
        assert_eq!(load_from_dir(directory.path()).0, updated.0);
    }
    #[test]
    fn partial_preferences_prioritize_saved_choices_over_defaults() {
        let partial = serde_json::json!({"version": 1, "bindings": {"capture": ShortcutAction::Record.default_binding().to_string()}});
        let loaded = decode(&serde_json::to_vec(&partial).unwrap()).unwrap();
        assert_eq!(loaded.get(ShortcutAction::Record), None);
        assert_eq!(
            loaded.get(ShortcutAction::Capture),
            Some(ShortcutAction::Record.default_binding())
        );
        assert!(
            decode(br#"{"version":1,"bindings":{"capture":"Alt+KeyA","record":"Alt+KeyA"}}"#)
                .is_err()
        );
    }
    #[derive(Default)]
    struct FakeRegistrar {
        registered: RefCell<HashSet<u32>>,
        unavailable: HashSet<u32>,
        register_failure: Option<String>,
        validation_failure: Option<(u32, String)>,
        fail_unregister: HashSet<u32>,
        operations: RefCell<Vec<(&'static str, u32)>>,
        after_register: Option<Box<dyn Fn()>>,
    }
    impl Registrar for FakeRegistrar {
        fn validate(&self, key: Shortcut) -> Result<(), String> {
            match &self.validation_failure {
                Some((id, error)) if *id == key.id() => Err(error.clone()),
                _ => Ok(()),
            }
        }
        fn is_registered(&self, key: Shortcut) -> bool {
            self.registered.borrow().contains(&key.id())
        }
        fn register(&self, key: Shortcut) -> Result<(), String> {
            self.operations.borrow_mut().push(("register", key.id()));
            if self.unavailable.contains(&key.id()) {
                return Err(self
                    .register_failure
                    .clone()
                    .unwrap_or_else(|| "occupied".into()));
            }
            self.registered.borrow_mut().insert(key.id());
            if let Some(after_register) = &self.after_register {
                after_register();
            }
            Ok(())
        }
        fn unregister(&self, key: Shortcut) -> Result<(), String> {
            self.operations.borrow_mut().push(("unregister", key.id()));
            if self.fail_unregister.contains(&key.id()) {
                return Err("cannot release".into());
            }
            self.registered.borrow_mut().remove(&key.id());
            Ok(())
        }
    }
    #[test]
    fn registration_failure_keeps_previous_without_persisting() {
        let previous = default_binding();
        let candidate = parse("F13").unwrap();
        let registrar = FakeRegistrar {
            unavailable: [candidate.id()].into(),
            ..Default::default()
        };
        registrar.register(previous).unwrap();
        assert!(replace_transaction(
            &registrar,
            Some(previous),
            Some(candidate),
            true,
            || panic!("must not persist")
        )
        .is_err());
        assert!(registrar.is_registered(previous));
        assert!(!registrar.is_registered(candidate));
    }
    #[test]
    fn media_permission_failure_keeps_previous_and_returns_specific_guidance() {
        let previous = default_binding();
        let candidate = parse("MediaPlayPause").unwrap();
        let registrar = FakeRegistrar {
            unavailable: [candidate.id()].into(),
            register_failure: Some(MEDIA_KEY_ACCESS_ERROR.into()),
            ..Default::default()
        };
        registrar.register(previous).unwrap();
        assert_eq!(
            replace_transaction(&registrar, Some(previous), Some(candidate), true, || {
                panic!("permission failure must not persist")
            })
            .unwrap_err(),
            MEDIA_KEY_ACCESS_ERROR
        );
        assert!(registrar.is_registered(previous));
        assert!(!registrar.is_registered(candidate));
        assert_eq!(
            registration_error("occupied"),
            "This shortcut is unavailable. Choose another combination."
        );
    }
    #[test]
    fn registers_before_release_and_rolls_back_failed_write() {
        let previous = default_binding();
        let candidate = parse("Space").unwrap();
        let registrar = FakeRegistrar::default();
        registrar.register(previous).unwrap();
        registrar.operations.borrow_mut().clear();
        assert!(
            replace_transaction(&registrar, Some(previous), Some(candidate), true, || Err(
                "disk full".into()
            ))
            .is_err()
        );
        assert_eq!(
            *registrar.operations.borrow(),
            vec![
                ("register", candidate.id()),
                ("unregister", previous.id()),
                ("unregister", candidate.id()),
                ("register", previous.id())
            ]
        );
        assert!(registrar.is_registered(previous));
        assert!(!registrar.is_registered(candidate));
    }
    #[test]
    fn release_failure_discards_candidate_and_preserves_previous() {
        let previous = default_binding();
        let candidate = parse("Alt+KeyK").unwrap();
        let registrar = FakeRegistrar {
            fail_unregister: [previous.id()].into(),
            ..Default::default()
        };
        registrar.register(previous).unwrap();
        assert!(replace_transaction(
            &registrar,
            Some(previous),
            Some(candidate),
            true,
            || panic!("must not persist")
        )
        .is_err());
        assert!(registrar.is_registered(previous));
        assert!(!registrar.is_registered(candidate));
    }
    #[test]
    fn disabling_releases_one_binding_and_rolls_back_failed_write() {
        let previous = default_binding();
        let other = ShortcutAction::Ocr.default_binding();
        let registrar = FakeRegistrar::default();
        registrar.register(previous).unwrap();
        registrar.register(other).unwrap();
        assert!(
            replace_transaction(&registrar, Some(previous), None, true, || Err(
                "disk full".into()
            ))
            .is_err()
        );
        assert!(registrar.is_registered(previous));
        replace_transaction(&registrar, Some(previous), None, true, || Ok(())).unwrap();
        assert!(!registrar.is_registered(previous));
        assert!(registrar.is_registered(other));
    }
    #[test]
    fn retry_same_unregistered_binding_rolls_back_failed_write() {
        let key = default_binding();
        let registrar = FakeRegistrar::default();
        assert!(
            replace_transaction(&registrar, Some(key), Some(key), true, || Err(
                "disk full".into()
            ))
            .is_err()
        );
        assert!(!registrar.is_registered(key));
        replace_transaction(&registrar, Some(key), Some(key), true, || Ok(())).unwrap();
        assert!(registrar.is_registered(key));
    }

    #[test]
    fn dormant_candidate_validation_failure_preserves_saved_binding_without_native_operations() {
        for (value, error) in [
            ("MediaPlayPause", MEDIA_KEY_ACCESS_ERROR),
            ("F24", UNSUPPORTED_KEY_ERROR),
        ] {
            let previous = ShortcutAction::RecordingPauseResume.default_binding();
            let candidate = parse(value).unwrap();
            let registrar = FakeRegistrar {
                validation_failure: Some((candidate.id(), error.into())),
                ..Default::default()
            };
            let mut saved = previous;
            assert_eq!(
                replace_transaction(&registrar, Some(previous), Some(candidate), false, || {
                    saved = candidate;
                    Ok(())
                })
                .unwrap_err(),
                error
            );
            assert_eq!(saved, previous);
            assert!(registrar.operations.borrow().is_empty());
            assert!(registrar.registered.borrow().is_empty());
        }
    }

    #[test]
    fn valid_dormant_candidate_saves_without_registering_or_testing_live_conflicts() {
        let previous = ShortcutAction::RecordingPauseResume.default_binding();
        let candidate = parse("Space").unwrap();
        let registrar = FakeRegistrar {
            unavailable: [candidate.id()].into(),
            ..Default::default()
        };
        let mut saved = previous;
        replace_transaction(&registrar, Some(previous), Some(candidate), false, || {
            saved = candidate;
            Ok(())
        })
        .unwrap();
        assert_eq!(saved, candidate);
        assert!(registrar.operations.borrow().is_empty());
        assert!(registrar.registered.borrow().is_empty());
    }

    #[test]
    fn recording_bindings_are_dormant_until_active_and_release_on_stop() {
        let state = ShortcutBindings::new(Bindings::default());
        let registrar = FakeRegistrar::default();
        let pause = ShortcutAction::RecordingPauseResume.default_binding();
        let stop = ShortcutAction::RecordingStop.default_binding();
        let capture = default_binding();
        registrar.register(capture).unwrap();
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(!registrar.is_registered(pause));
        assert_eq!(state.press(&pause), None);
        assert!(state.set_recording_active(true));
        let epoch = state.recording_epoch();
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(registrar.is_registered(pause));
        assert!(registrar.is_registered(stop));
        assert_eq!(
            state.press(&pause),
            Some(ShortcutAction::RecordingPauseResume)
        );
        assert_eq!(state.press(&pause), None);
        assert!(
            !state.set_recording_active(true),
            "pause/resume must preserve the registration epoch"
        );
        assert_eq!(state.recording_epoch(), epoch);
        assert!(state.set_recording_active(false));
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(!registrar.is_registered(pause));
        assert!(!registrar.is_registered(stop));
        assert!(registrar.is_registered(capture));
        assert_eq!(state.press(&pause), None);
        state.set_recording_active(true);
        assert_eq!(
            state.press(&pause),
            Some(ShortcutAction::RecordingPauseResume),
            "unregister clears a held key whose release will no longer be delivered"
        );
    }

    #[test]
    fn queued_start_and_stop_reconcile_only_the_latest_scope() {
        let state = ShortcutBindings::new(Bindings::default());
        let registrar = FakeRegistrar::default();
        state.set_recording_active(true);
        state.set_recording_active(false);
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(registrar.operations.borrow().is_empty());
    }

    #[test]
    fn stop_during_native_registration_leaves_no_recording_keys_owned() {
        let state = std::sync::Arc::new(ShortcutBindings::new(Bindings::default()));
        state.set_recording_active(true);
        let target = state.clone();
        let registrar = FakeRegistrar {
            after_register: Some(Box::new(move || {
                target.set_recording_active(false);
            })),
            ..Default::default()
        };
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(registrar.registered.borrow().is_empty());
    }

    #[test]
    fn one_occupied_recording_key_does_not_skip_the_other_or_touch_global_keys() {
        let state = ShortcutBindings::new(Bindings::default());
        state.set_recording_active(true);
        let pause = ShortcutAction::RecordingPauseResume.default_binding();
        let stop = ShortcutAction::RecordingStop.default_binding();
        let registrar = FakeRegistrar {
            unavailable: [pause.id()].into(),
            ..Default::default()
        };
        assert!(reconcile_recording_scope(&state, &registrar));
        assert!(!registrar.is_registered(pause));
        assert!(registrar.is_registered(stop));
        assert_eq!(registrar.operations.borrow().len(), 2);
        state.set_recording_active(false);
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(!registrar.is_registered(stop));
    }

    #[test]
    fn disabled_recording_bindings_stay_unregistered_and_saved_global_choices_win() {
        let partial = serde_json::json!({"version":1,"bindings":{
            "capture": ShortcutAction::RecordingPauseResume.default_binding().to_string(),
            "recordingStop": null
        }});
        let bindings = decode(&serde_json::to_vec(&partial).unwrap()).unwrap();
        assert_eq!(bindings.get(ShortcutAction::RecordingPauseResume), None);
        assert_eq!(bindings.get(ShortcutAction::RecordingStop), None);
        let state = ShortcutBindings::new(bindings);
        state.set_recording_active(true);
        let registrar = FakeRegistrar::default();
        assert!(!reconcile_recording_scope(&state, &registrar));
        assert!(registrar.operations.borrow().is_empty());
    }
}
